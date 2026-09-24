// POST /api/webhook
// O Mercado Pago chama essa rota sozinho sempre que algo muda numa assinatura ou num pagamento.
// Assinatura (cartão): libera/bloqueia o Plus conforme o status.
// Pix avulso: quando aprovado, libera o Plus por 30 dias (mensal) ou 365 dias (anual).

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const DIAS_PIX = { mensal: 30, anual: 365 };

export default async function handler(req, res) {
  try {
    const body = req.body || {};
    const topic = body.type || body.topic || req.query.type || req.query.topic;
    const id = body.data?.id || req.query['data.id'] || req.query.id;

    // Assinatura no cartão
    if ((topic === 'subscription_preapproval' || topic === 'preapproval') && id) {
      const resp = await fetch(`https://api.mercadopago.com/preapproval/${id}`, {
        headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
      });
      const pre = await resp.json();

      const email = pre.payer_email;
      const status = pre.status; // 'authorized' | 'paused' | 'cancelled' | 'pending'
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

    // Pix avulso
    if (topic === 'payment' && id) {
      await processarPix(id);
    }

    // Sempre responde 200 rapidinho, senão o Mercado Pago fica tentando de novo
    res.status(200).json({ recebido: true });
  } catch (e) {
    console.error(e);
    res.status(200).json({ recebido: true });
  }
}

async function processarPix(id) {
  const resp = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
    headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
  });
  const pag = await resp.json();

  if (pag.payment_method_id !== 'pix' || pag.status !== 'approved') return;

  const ref = pag.external_reference || '';
  const sep = ref.indexOf('|');
  if (sep === -1) return;

  const plano = ref.slice(0, sep);
  const email = ref.slice(sep + 1);
  const dias = DIAS_PIX[plano];
  if (!dias || !email) return;

  const { data: atual } = await supabase
    .from('subscribers')
    .select('premium_ate, mp_payment_id')
    .eq('email', email)
    .maybeSingle();

  // Mesmo pagamento chegando de novo: não soma dias duas vezes
  if (atual?.mp_payment_id === String(id)) return;

  // Se ainda tem Plus válido, soma os dias em cima; senão, conta a partir de agora
  const agora = new Date();
  const base = atual?.premium_ate && new Date(atual.premium_ate) > agora ? new Date(atual.premium_ate) : agora;
  const premiumAte = new Date(base.getTime() + dias * 24 * 60 * 60 * 1000);

  await supabase.from('subscribers').upsert({
    email,
    plano,
    premium: true,
    premium_ate: premiumAte.toISOString(),
    status: 'pix_pago',
    mp_payment_id: String(id),
    updated_at: agora.toISOString(),
  });
}
