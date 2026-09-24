// POST /api/criar-assinatura
// Recebe { email, plano } e cria uma assinatura recorrente no Mercado Pago.
// Devolve a URL de checkout para o usuário pagar (cartão ou Pix).

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const PLANOS = {
  mensal: { reason: 'Aprumo Plus - Mensal', frequency: 1, frequency_type: 'months', transaction_amount: 1.00 },
  anual:  { reason: 'Aprumo Plus - Anual',  frequency: 12, frequency_type: 'months', transaction_amount: 239.90 },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'method_not_allowed' });

  const { email, plano } = req.body || {};
  if (!email || !PLANOS[plano]) {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'Informe email e plano (mensal ou anual).' });
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
        back_url: process.env.APP_URL || 'https://seu-app.vercel.app',
        status: 'pending',
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error('Erro Mercado Pago:', data);
      return res.status(500).json({ erro: 'mp_error', detalhe: data });
    }

    await supabase.from('subscribers').upsert({
      email,
      plano,
      mp_preapproval_id: data.id,
      status: 'pending',
      premium: false,
    });

    return res.status(200).json({ checkout_url: data.init_point });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: 'server_error' });
  }
}
