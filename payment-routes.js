import crypto from 'node:crypto';

const GATEWAY_MERCHANT_ID = process.env.INPAY_MERCHANT_ID || process.env.PAYMENT_MERCHANT_ID || '';
const GATEWAY_TOKEN = process.env.INPAY_MERCHANT_TOKEN || process.env.PAYMENT_MERCHANT_TOKEN || '';
const GATEWAY_API_BASE = process.env.PAYMENT_API_BASE || 'https://inpay.uz/api/v1';
const CALLBACK_URL = process.env.CALLBACK_URL || 'https://example.com/api/webhook';

function newId() { return crypto.randomUUID(); }

async function fetchRetry(url, options, tries = 3, delayMs = 350) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fetch(url, options); }
    catch (e) { lastErr = e; if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs)); }
  }
  throw lastErr;
}

async function gatewayGetBearer() {
  const r = await fetchRetry(
    `${GATEWAY_API_BASE}/authorization/?merchant_id=${GATEWAY_MERCHANT_ID}&merchant_token=${GATEWAY_TOKEN}`
  );
  const d = await r.json();
  if (!d.success || !d.bearer_token) throw new Error(`Gateway auth failed: ${d.message || JSON.stringify(d)}`);
  return d.bearer_token;
}

async function createGatewayPayment({ amountSom, description }) {
  const bearer = await gatewayGetBearer();
  const r = await fetchRetry(`${GATEWAY_API_BASE}/create/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({
      merchant_id: GATEWAY_MERCHANT_ID,
      token: GATEWAY_TOKEN,
      amount: amountSom,
      description,
      success_url: CALLBACK_URL,
      fail_url: CALLBACK_URL,
    }),
  });
  const data = await r.json();
  if (!data.success) throw new Error(`Gateway create error: ${data.message || JSON.stringify(data)}`);
  return { url: data.pay_url || data.url, gatewayOrderId: data.cardsystem_order_id || data.order_id };
}

const PAID_STATUSES = ['success', 'paid', 'completed'];
async function checkGatewayStatus(gatewayOrderId) {
  const bearer = await gatewayGetBearer();
  const r = await fetchRetry(`${GATEWAY_API_BASE}/transactions/?order_id=${encodeURIComponent(gatewayOrderId)}`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (!r.ok) return false;
  const resp = await r.json();
  const rows = Array.isArray(resp?.data) ? resp.data : [resp?.data].filter(Boolean);
  return rows.some((tx) => PAID_STATUSES.includes(String(tx?.status || '').toLowerCase()));
}

async function markPaymentAsPaid(supabase, orderId, userId, amount) {
  const { data, error } = await supabase
    .from('payments')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', orderId)
    .eq('status', 'pending')
    .select();

  if (error || !data || data.length === 0) return false;

  if (userId && amount > 0) {
    const { data: user } = await supabase
      .from('xusers')
      .select('balance')
      .eq('user_id', userId)
      .maybeSingle();

    const currentBalance = Number(user?.balance || 0);
    const newBalance = currentBalance + Number(amount);

    await supabase
      .from('xusers')
      .update({ balance: newBalance })
      .eq('user_id', userId);
  }
  return true;
}

export function registerPaymentRoutes(app, supabase) {
  app.post('/api/payment/create', async (req, res) => {
    try {
      const amount = Math.round(Number(req.body?.amount));
      const userId = req.body?.user_id || req.body?.userId;
      const paymentMethod = req.body?.payment_method || 'click';

      if (!amount || amount < 1000) {
        return res.status(400).json({ error: "amount kerak (minimal 1000 so'm)" });
      }

      const { url, gatewayOrderId } = await createGatewayPayment({
        amountSom: amount,
        description: 'ForeverTV hisobni to\'ldirish',
      });

      if (!url) return res.status(502).json({ error: "To'lov URL olinmadi" });

      const orderId = newId();
      await supabase.from('payments').insert({
        id: orderId,
        user_id: userId,
        amount: amount,
        payment_method: paymentMethod,
        inpay_order_id: gatewayOrderId,
        status: 'pending',
      });

      res.json({ url, order_id: orderId, amount });
    } catch (e) {
      console.error('[payment/create]', e.message);
      res.status(502).json({ error: e.message });
    }
  });

  app.post('/api/payment/status', async (req, res) => {
    try {
      const orderId = req.body?.order_id || req.body?.orderId;
      if (!orderId) return res.status(400).json({ error: 'order_id kerak' });

      const { data: order } = await supabase.from('payments').select('*').eq('id', orderId).maybeSingle();
      if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });

      if (order.status === 'paid') return res.json({ paid: true });

      const paid = await checkGatewayStatus(order.inpay_order_id);
      if (paid) {
        await markPaymentAsPaid(supabase, order.id, order.user_id, order.amount);
      }
      res.json({ paid });
    } catch (e) {
      console.error('[payment/status]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/webhook', async (req, res) => {
    try {
      const gatewayOrderId = req.body?.order_id || req.body?.orderId;
      if (!gatewayOrderId) return res.sendStatus(400);

      const { data: order } = await supabase.from('payments').select('*').eq('inpay_order_id', gatewayOrderId).maybeSingle();
      if (order) {
        await markPaymentAsPaid(supabase, order.id, order.user_id, order.amount);
      }
      res.sendStatus(200);
    } catch (e) {
      console.error('[api/webhook]', e.message);
      res.sendStatus(500);
    }
  });
}
