// GET /api/status?email=...
// O app chama essa rota pra saber se a pessoa realmente está com o Plus ativo.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const email = req.query.email;
  if (!email) return res.status(400).json({ erro: 'email_obrigatorio' });

  const { data } = await supabase
    .from('subscribers')
    .select('premium, plano, status')
    .eq('email', email)
    .maybeSingle();

  res.status(200).json({
    premium: !!data?.premium,
    plano: data?.plano || null,
    status: data?.status || null,
  });
}
