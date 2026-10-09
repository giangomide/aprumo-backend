// POST /api/whatsapp-token
// O app chama isso quando a pessoa toca em "Anote pelo WhatsApp".
// Cria um código de uso único (vale 30 minutos) que vai escondido na mensagem "Oi, Avanzi! 👋",
// e devolve o número do Avanzi para o app abrir a conversa.
//
// Configuração: WHATSAPP_NUMERO = número do Avanzi com DDI e DDD, só números (ex: 5511999998888).
// Enquanto ela não existir, o app continua mostrando "Em breve".

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ALFA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

async function usuarioLogado(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data || !data.user) return null;
  return data.user;
}

// cada letra vira 5 "bits" de caracteres invisíveis
function esconder(codigo) {
  let bits = '';
  for (const c of codigo) bits += ALFA.indexOf(c).toString(2).padStart(5, '0');
  return '⁠' + bits.split('').map((b) => (b === '1' ? '‌' : '​')).join('') + '⁠';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const numero = String(process.env.WHATSAPP_NUMERO || '').replace(/\D/g, '');
  // GET: o app só quer saber se o WhatsApp já está no ar (para trocar o "Em breve")
  if (req.method === 'GET') return res.status(200).json(numero ? { disponivel: true, conversa: 'https://wa.me/' + numero } : { disponivel: false });
  if (req.method !== 'POST') return res.status(405).json({ erro: 'method_not_allowed' });
  if (!numero) return res.status(200).json({ disponivel: false });

  try {
    const user = await usuarioLogado(req);
    if (!user) return res.status(401).json({ erro: 'nao_logado' });

    let codigo = '';
    const bytes = crypto.randomBytes(6);
    for (const b of bytes) codigo += ALFA[b % ALFA.length];

    await supabase.from('whatsapp_pending').delete().eq('user_id', user.id);
    const { error } = await supabase.from('whatsapp_pending').insert({ token: codigo, user_id: user.id });
    if (error) throw error;

    const mensagem = 'Oi, Avanzi! 👋' + esconder(codigo);
    return res.status(200).json({
      disponivel: true,
      codigo,
      link: 'https://wa.me/' + numero + '?text=' + encodeURIComponent(mensagem),
      conversa: 'https://wa.me/' + numero,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: 'server_error' });
  }
}
