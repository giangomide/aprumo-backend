// POST /api/cancelar-assinatura
// Recebe { email }. Cancela a renovação automática no cartão (se houver).
// O Plus continua até o fim do período já pago; depois some sozinho.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'method_not_allowed' });

  const { email } = req.body || {};
  if (!email) return res.status(400).json({ erro: 'email_obrigatorio' });

  try {
    const { data: sub, error } = await supabase
      .from('subscribers')
      .select('mp_preapproval_id, status, premium_ate')
      .eq('email', email)
      .maybeSingle();

    if (error) throw error;
    if (!sub) return res.status(404).json({ erro: 'nao_encontrado' });

    let premiumAte = sub.premium_ate;

    // Assinatura no cartão: cancela no Mercado Pago
    if (sub.mp_preapproval_id && sub.status !== 'cancelled') {
      const headers = {
        Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      };
      const url = `https://api.mercadopago.com/preapproval/${sub.mp_preapproval_id}`;

      const atual = await fetch(url, { headers }).then((r) => r.json());

      const resp = await fetch(url, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ status: 'cancelled' }),
      });

      if (!resp.ok) {
        const d = await resp.json();
        console.error('Erro ao cancelar no Mercado Pago:', d);
        return res.status(500).json({ erro: 'mp_error', detalhe: d });
      }

      // Estava pagando em dia: mantém o Plus até a data da próxima cobrança (que não vai mais acontecer)
      if (atual.status === 'authorized' && atual.next_payment_date) {
        const fim = new Date(atual.next_payment_date);
        if (!premiumAte || fim > new Date(premiumAte)) premiumAte = fim.toISOString();
      }
    }

    await supabase
      .from('subscribers')
      .update({ status: 'cancelled', premium_ate: premiumAte, updated_at: new Date().toISOString() })
      .eq('email', email);

    return res.status(200).json({ cancelado: true, premium_ate: premiumAte });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: 'server_error' });
  }
}
