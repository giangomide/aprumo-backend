// POST /api/pagar-pix
// Recebe { plano } de quem está logado e gera um Pix avulso no Mercado Pago.
// O Plus é liberado pelo webhook quando o Pix for pago.

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const PLANOS_PIX = {
  mensal: { descricao: 'Aprumo Plus - Mensal (Pix)', valor: 30.00 },
  anual:  { descricao: 'Aprumo Plus - Anual (Pix)',  valor: 239.90 },
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
  if (!PLANOS_PIX[plano]) {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'Escolha o plano mensal ou anual.' });
  }
  const p = PLANOS_PIX[plano];

  try {
    const resp = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        transaction_amount: p.valor,
        description: p.descricao,
        payment_method_id: 'pix',
        payer: { email },
        external_reference: `${plano}|${email}`,
        notification_url: 'https://aprumo-backend.vercel.app/api/webhook',
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error('Erro Mercado Pago (Pix):', data);
      return res.status(500).json({ erro: 'mp_error', detalhe: data });
    }

    const tx = data.point_of_interaction?.transaction_data || {};
    return res.status(200).json({
      payment_id: data.id,
      checkout_url: tx.ticket_url,
      qr_code: tx.qr_code,
      qr_code_base64: tx.qr_code_base64,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: 'server_error' });
  }
}
