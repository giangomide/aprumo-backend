// POST /api/push-inscrever
// Guarda (ou remove) o "endereço de notificação" do aparelho de quem está logado.
// Corpo: { sub } para ativar, ou { acao: 'sair', endpoint } para desativar.

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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'method_not_allowed' });

  try {
    const user = await usuarioLogado(req);
    if (!user) return res.status(401).json({ erro: 'nao_logado' });
    const { sub, acao, endpoint } = req.body || {};

    if (acao === 'sair') {
      if (endpoint) await supabase.from('push_subs').delete().eq('endpoint', endpoint).eq('user_id', user.id);
      return res.status(200).json({ ok: true });
    }

    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return res.status(400).json({ erro: 'dados_invalidos' });
    }
    const { error } = await supabase.from('push_subs').upsert({ endpoint: sub.endpoint, user_id: user.id, sub, updated_at: new Date().toISOString() });
    if (error) throw error;
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: 'server_error' });
  }
}
