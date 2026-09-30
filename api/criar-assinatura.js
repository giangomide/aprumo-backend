// POST /api/criar-assinatura
// Recebe { plano } de quem está logado e cria uma assinatura recorrente (cartão) no Mercado Pago.
// Devolve a URL de checkout.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const PLANOS = {
  mensal: { reason: 'Aprumo Plus - Mensal', frequency: 1, frequency_type: 'months', transaction_amount: 19.99 },
  anual:  { reason: 'Aprumo Plus - Anual',  frequency: 12, frequency_type: 'months', transaction_amount: 179.90 },
};

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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'method_not_allowed' });

  const user = await usuarioLogado(req);
  if (!user) return res.status(401).json({ erro: 'nao_logado', mensagem: 'Entre na sua conta para assinar.' });
  const email = user.email.toLowerCase();

  const { plano } = req.body || {};
  if (!PLANOS[plano]) {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'Escolha o plano mensal ou anual.' });
  }
  const p = PLANOS[plano];

  try {
    const resp = await fetch('https://api.mercadopago.com/preapproval', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        reason: p.reason,
        auto_recurring: {
          frequency: p.frequency,
          frequency_type: p.frequency_type,
          transaction_amount: p.transaction_amount,
          currency_id: 'BRL',
        },
        payer_email: email,
        back_url: process.env.APP_URL || 'https://aprumo-app-hazel.vercel.app',
        status: 'pending',
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error('Erro Mercado Pago:', data);
      return res.status(500).json({ erro: 'mp_error', detalhe: data });
    }

    // guarda o vínculo da assinatura sem mexer em quem já tem Plus
    const { data: atual } = await supabase.from('subscribers').select('email').eq('email', email).maybeSingle();
    if (atual) {
      await supabase.from('subscribers').update({ plano, mp_preapproval_id: data.id, updated_at: new Date().toISOString() }).eq('email', email);
    } else {
      await supabase.from('subscribers').insert({ email, plano, mp_preapproval_id: data.id, status: 'pending', premium: false });
    }

    return res.status(200).json({ checkout_url: data.init_point });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: 'server_error' });
  }
}
