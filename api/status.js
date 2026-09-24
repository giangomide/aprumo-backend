// GET /api/status?email=...
// Diz para o app se o usuário tem Plus ativo agora.
// Cartão: vale enquanto a assinatura estiver ativa (premium = true).
// Pix: vale até a data em premium_ate. Depois disso, o Plus some sozinho.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const email = (req.query.email || '').trim();
  if (!email) return res.status(400).json({ erro: 'email_obrigatorio' });

  try {
    const { data, error } = await supabase
      .from('subscribers')
      .select('premium, plano, premium_ate, status')
      .eq('email', email)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(200).json({ premium: false, plano: null });

    let premium = !!data.premium;

    // Pix: se já passou da data de validade, o Plus acabou
    if (data.premium_ate && new Date(data.premium_ate) <= new Date()) {
      premium = false;
    }

    return res.status(200).json({
      premium,
      plano: data.plano || null,
      premium_ate: data.premium_ate || null,
      status: data.status || null,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: 'server_error' });
  }
}
