// POST /api/pagar-pix
// Recebe { email, plano } e gera um Pix avulso no Mercado Pago.
// Devolve a página do Pix (QR Code + copia e cola). O Plus é liberado pelo webhook quando o Pix for pago.

import crypto from 'crypto';

const PLANOS_PIX = {
  mensal: { descricao: 'Aprumo Plus - Mensal (Pix)', valor: 39.00 }, // TESTE: voltar para 30.00 depois
  anual:  { descricao: 'Aprumo Plus - Anual (Pix)',  valor: 239.90 },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'method_not_allowed' });

  const { email, plano } = req.body || {};
  if (!email || !PLANOS_PIX[plano]) {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'Informe email e plano (mensal ou anual).' });
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
      checkout_url: tx.ticket_url,      // página do Mercado Pago com o QR Code
      qr_code: tx.qr_code,              // código copia e cola
      qr_code_base64: tx.qr_code_base64 // imagem do QR Code
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: 'server_error' });
  }
}
