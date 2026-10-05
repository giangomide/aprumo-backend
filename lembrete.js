// GET /api/lembrete
// Roda sozinho todo dia às 21h (horário de Brasília) pela agenda da Vercel.
// Manda um lembrete para cada aparelho que ativou as notificações:
//   - quem ainda não anotou nada hoje: "Anotou seus gastos de hoje?"
//   - quem já anotou: "Hoje ainda dá pra gastar R$ X"

import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function hojeBrasil() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()); // AAAA-MM-DD
}
function diaBrasil(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(ts));
}
function brl(v) {
  return 'R$ ' + Number(v).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export default async function handler(req, res) {
  // só a agenda da Vercel (ou quem tiver o segredo) pode disparar
  const segredo = process.env.CRON_SECRET;
  if (!segredo || req.headers.authorization !== `Bearer ${segredo}`) return res.status(401).json({ erro: 'nao_autorizado' });

  webpush.setVapidDetails('mailto:contatoaprumoapp@gmail.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

  try {
    const { data: subs, error } = await supabase.from('push_subs').select('endpoint, user_id, sub');
    if (error) throw error;
    if (!subs || !subs.length) return res.status(200).json({ enviados: 0 });

    const ids = [...new Set(subs.map((s) => s.user_id))];
    const { data: dados } = await supabase.from('user_data').select('user_id, data').in('user_id', ids);
    const porUsuario = {};
    (dados || []).forEach((d) => { porUsuario[d.user_id] = d.data || {}; });

    const hoje = hojeBrasil();
    let enviados = 0, removidos = 0;

    for (const s of subs) {
      const d = porUsuario[s.user_id] || {};
      const anotouHoje = (d.txs || []).some((t) => t && t.ts && diaBrasil(t.ts) === hoje);
      let msg = null;
      if (!anotouHoje) {
        msg = { title: 'Anotou seus gastos de hoje?', body: 'Leva 10 segundos, e o seu "quanto posso gastar" fica certinho 💚' };
      } else if (d.hojeInfo && d.hojeInfo.d === hoje && d.hojeInfo.v > 0) {
        msg = { title: 'Hoje ainda dá pra gastar ' + brl(d.hojeInfo.v), body: 'Fechou bem o dia? Se sobrar, manda pra sua meta 🎯' };
      }
      if (!msg) continue;
      try {
        await webpush.sendNotification(s.sub, JSON.stringify({ ...msg, url: '/' }), { TTL: 3600 });
        enviados++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          await supabase.from('push_subs').delete().eq('endpoint', s.endpoint);
          removidos++;
        } else console.error('Erro ao enviar lembrete:', e.statusCode, e.body);
      }
    }
    return res.status(200).json({ enviados, removidos });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: 'server_error' });
  }
}
