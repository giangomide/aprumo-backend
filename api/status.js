// GET /api/status
// Diz para o app se a pessoa logada tem Plus ativo agora.
// Cartão ativo: Plus liberado. Pix ou cartão cancelado: vale até a data em premium_ate.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Confere quem está pedindo: o app manda o "token" do login e o Supabase diz de quem ele é.
async function usuarioLogado(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data || !data.user || !data.user.email) return null;
  return data.user;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const user = await usuarioLogado(req);
    if (!user) return res.status(401).json({ erro: 'nao_logado', premium: false });
    const email = user.email.toLowerCase();

    const { data, error } = await supabase
      .from('subscribers')
      .select('premium, plano, premium_ate, status')
      .eq('email', email)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(200).json({ premium: false, plano: null });

    const dentroDoPrazo = !!data.premium_ate && new Date(data.premium_ate) > new Date();
    const cartaoAtivo = data.status === 'authorized';

    return res.status(200).json({
      premium: cartaoAtivo || dentroDoPrazo,
      plano: data.plano || null,
      premium_ate: data.premium_ate || null,
      status: data.status || null,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: 'server_error' });
  }
}
