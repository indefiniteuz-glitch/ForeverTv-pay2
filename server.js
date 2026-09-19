import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { registerPaymentRoutes } from './payment-routes.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabase = createClient(supabaseUrl, supabaseKey);

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'ForeverTV Payment Backend' });
});

registerPaymentRoutes(app, supabase);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Payment backend server ${PORT}-portda ishga tushdi.`);
});
