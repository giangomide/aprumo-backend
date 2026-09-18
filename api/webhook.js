// POST /api/webhook
// O Mercado Pago chama essa rota sozinho sempre que algo muda numa assinatura
// (pagamento aprovado, cancelamento, etc). É aqui que o Plus é liberado de verdade.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  try {
    const body = req.body || {};
    const topic = body.type || req.query.type || req.query.topic;
    const id = body.data?.id || req.query.id || req.query['data.id'];

    if ((topic === 'subscription_preapproval' || topic === 'preapproval') && id) {
      const resp = await fetch(`https://api.mercadopago.com/preapproval/${id}`, {
        headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
      });
      const pre = await resp.json();

      const email = pre.payer_email;
      const status = pre.status; // 'authorized' (pagando em dia) | 'paused' | 'cancelled' | 'pending'
      const premium = status === 'authorized';

      if (email) {
        await supabase.from('subscribers').upsert({
          email,
          premium,
          mp_preapproval_id: id,
          status,
          updated_at: new Date().toISOString(),
        });
      }
    }

    // Sempre responde 200 rapidinho, senão o Mercado Pago fica tentando de novo
    res.status(200).json({ recebido: true });
  } catch (e) {
    console.error(e);
    res.status(200).json({ recebido: true });
  }
}
