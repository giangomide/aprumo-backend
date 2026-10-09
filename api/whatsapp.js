// /api/whatsapp
// É aqui que o WhatsApp entrega as mensagens que as pessoas mandam para o número do Avanzi.
//
// O que ele faz:
//   - "Oi, Avanzi! 👋" vindo do botão do app  → liga aquele número de WhatsApp à conta da pessoa
//   - "gastei 32 no almoço"                    → anota o gasto (o app puxa sozinho quando abrir)
//   - áudio                                    → transcreve e trata igual a texto
//   - "posso comprar um tênis de 300?"         → responde com o impacto no dia e nas metas
//   - foto de um produto com preço             → mesma coisa do "posso comprar?"
//
// Configurações (Vercel → Settings → Environment Variables):
//   WHATSAPP_TOKEN            token permanente da Meta (System User)
//   WHATSAPP_PHONE_NUMBER_ID  id do número do Avanzi na Meta
//   WHATSAPP_VERIFY_TOKEN     uma senha inventada, a mesma colocada na tela de webhook da Meta
//   WHATSAPP_APP_SECRET       "App secret" do app na Meta (confere que a mensagem veio mesmo da Meta)
//   OPENAI_API_KEY            só para entender áudios (sem ela, o Avanzi pede para mandar por texto)
//   WHATSAPP_SO_PLUS          coloque 1 se quiser o WhatsApp só para quem é Plus (padrão: liberado para todos)

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: false } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const GRAPH = 'https://graph.facebook.com/v21.0';
const CATS = ['alimentacao', 'transporte', 'lazer', 'moradia', 'saude', 'roupas', 'mercado', 'outros'];
const NOME_CAT = { alimentacao: 'Alimentação', transporte: 'Transporte', lazer: 'Lazer', moradia: 'Moradia', saude: 'Saúde', roupas: 'Roupas', mercado: 'Mercado', outros: 'Outros' };
const FUSO = -3; // horário de Brasília

// ─── datas no horário de Brasília ────────────────────────────
function partes(ts) { const d = new Date(ts + FUSO * 3600000); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() }; }
function meioDia(y, m, d) { const ult = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); return Date.UTC(y, m, Math.min(d, ult), 12 - FUSO); }
function mesKey(y, m) { const n = new Date(Date.UTC(y, m, 1)); return n.getUTCFullYear() + '-' + (n.getUTCMonth() + 1); }
function isoDia(ts) { const p = partes(ts); return p.y + '-' + String(p.m + 1).padStart(2, '0') + '-' + String(p.d).padStart(2, '0'); }
function fmtDia(ts) { const p = partes(ts); const meses = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']; return p.d + '/' + meses[p.m]; }
function brl(v) { const n = Math.round(Number(v) * 100) / 100; return 'R$ ' + n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }

// ─── o mesmo cálculo do "quanto posso gastar hoje" do app ───
function calcularHoje(S, agora) {
  const txs = S.txs || [];
  const h = partes(agora); const { y, m } = h;
  const mk = mesKey(y, m);
  const diaR = S.diaRecebe ? S.diaRecebe : ((S.recorrentes || []).find((r) => r.tipo === 'receita') || {}).dia || 0;
  let rec = 0, gas = 0, gHoje = 0;
  txs.filter((t) => t.mk === mk).forEach((t) => {
    if (t.tipo === 'receita') rec += t.v;
    else { gas += t.v; const p = partes(t.ts); if (p.y === y && p.m === m && p.d === h.d) gHoje += t.v; }
  });
  const ini = (S.saldoInicial || {})[mk] || 0;
  if (ini <= 0 && rec <= 0) return { semDados: true };
  const temDia = diaR > 0;
  let prox;
  if (temDia) prox = h.d < diaR ? meioDia(y, m, diaR) : meioDia(y, m + 1, diaR);
  else prox = meioDia(y, m + 1, 1);
  const dias = Math.max(1, Math.round((prox - meioDia(y, m, h.d)) / 86400000));
  const fixas = (S.recorrentes || []).filter((r) => {
    if (r.tipo !== 'gasto') return false;
    const occ = r.ultimoMes !== mk ? meioDia(y, m, r.dia) : meioDia(y, m + 1, r.dia);
    return occ < prox;
  }).reduce((a, r) => a + r.v, 0);
  const metasAtivas = (S.metas || []).filter((x) => x.atual < x.total && x.mensal > 0);
  const metas = metasAtivas.reduce((a, x) => a + x.mensal, 0);
  const base = ini + rec - (gas - gHoje) - fixas - metas;
  const porDia = base / dias;
  return { semDados: false, porDia, gHoje, resta: porDia - gHoje, dias, prox, temDia, fixas, metas, sobraPeriodo: base - gHoje };
}

function resumoMetas(S) {
  return (S.metas || []).filter((x) => x.atual < x.total).map((x) => {
    const falta = x.total - x.atual;
    const meses = x.mensal > 0 ? falta / x.mensal : null;
    return { nome: x.nome, emoji: x.emoji || '', total: x.total, guardado: x.atual, falta, por_mes: x.mensal || 0, meses_para_chegar: meses ? Math.round(meses * 10) / 10 : null };
  });
}

// "Posso comprar?": transforma o preço em coisas que a pessoa sente
function simularCompra(S, valor, agora) {
  const h = calcularHoje(S, agora);
  if (h.semDados) return { sem_dados: true, aviso: 'A pessoa ainda não informou quanto recebe ou quanto tem. Peça para anotar o que recebeu no app (ou mandar aqui: "recebi 2000 de salário").' };
  const restaDepois = h.resta - valor;
  const novoPorDia = (h.sobraPeriodo - valor) / h.dias;
  const metas = resumoMetas(S).filter((x) => x.por_mes > 0).map((x) => ({
    nome: x.nome,
    atraso_em_semanas_se_sair_da_meta: Math.round((valor / (x.por_mes / 4.345)) * 10) / 10,
  }));
  return {
    valor,
    limite_de_hoje_antes: Math.round(h.resta * 100) / 100,
    cabe_no_limite_de_hoje: valor <= h.resta,
    sobra_hoje_depois: Math.round(restaDepois * 100) / 100,
    equivale_a_dias_do_limite: h.porDia > 0 ? Math.round((valor / h.porDia) * 10) / 10 : null,
    limite_por_dia_hoje: Math.round(h.porDia * 100) / 100,
    limite_por_dia_depois_da_compra: Math.round(novoPorDia * 100) / 100,
    dias_ate_proximo_pagamento: h.temDia ? h.dias : null,
    data_proximo_pagamento: h.temDia ? fmtDia(h.prox) : null,
    dinheiro_livre_ate_o_pagamento: Math.round(h.sobraPeriodo * 100) / 100,
    impacto_nas_metas: metas,
  };
}

// ─── instruções para a IA ────────────────────────────────────
function instrucoes(S, agora) {
  const h = calcularHoje(S, agora);
  const nome = (S.usuario && S.usuario !== 'Você') ? S.usuario.split(' ')[0] : '';
  const situacao = h.semDados
    ? 'A pessoa ainda não informou renda nem saldo, então não dá para calcular o limite do dia.'
    : 'Situação de agora: ' + (h.resta >= 0 ? 'ainda pode gastar ' + brl(h.resta) + ' hoje' : 'já passou ' + brl(-h.resta) + ' do limite de hoje') +
      '; o limite é ' + brl(h.porDia) + ' por dia' + (h.temDia ? ' até o próximo pagamento (' + fmtDia(h.prox) + ', faltam ' + h.dias + ' dias)' : ' até o fim do mês') + '.';
  const metas = resumoMetas(S);
  return [
    'Você é o Avanzi, um app brasileiro de finanças para jovens que estão começando. Você conversa pelo WhatsApp.',
    nome ? 'O nome da pessoa é ' + nome + '.' : '',
    'Hoje é ' + isoDia(agora) + ' (AAAA-MM-DD). Converta datas relativas (ontem, sexta passada) para AAAA-MM-DD.',
    situacao,
    metas.length ? 'Metas em andamento: ' + metas.map((x) => x.nome + ' (faltam ' + brl(x.falta) + (x.por_mes ? ', guarda ' + brl(x.por_mes) + '/mês' : '') + ')').join('; ') + '.' : 'A pessoa ainda não tem metas.',
    'Categorias (use o id exato): ' + CATS.join(', ') + '. Na dúvida, "outros".',
    'Se a pessoa contar um gasto ou recebimento com valor, chame registrar_lancamento (uma vez para cada item). O lançamento é salvo na hora, então confirme que anotou e diga quanto ainda dá para gastar hoje.',
    'Se a pessoa perguntar se pode comprar algo, ou mandar foto de um produto com preço, chame simular_compra com o valor e responda de forma honesta e amigável: diga se cabe no limite de hoje, quantos dias do limite isso representa e, se tiver metas, quantas semanas a meta atrasaria se o dinheiro saísse dela. Se não couber, sugira uma alternativa concreta (esperar o pagamento, comprar mais barato, dividir em dias). Nunca registre a compra só por ela ter perguntado.',
    'Se faltar o valor, pergunte de forma curta, pedindo para mandar tudo junto (ex: "posso comprar tênis de 300?"). Nunca invente valores.',
    'Para apagar ou editar algo já anotado, diga que é só abrir o app e tocar no lançamento.',
    'Se o assunto não for dinheiro, responda com gentileza em uma frase que você ajuda a anotar gastos e a decidir compras.',
    'Escreva em português do Brasil, curto, natural, como amigo no WhatsApp. Sem markdown, sem asteriscos, sem listas. No máximo 3 frases curtas e no máximo 1 emoji.',
  ].filter(Boolean).join(' ');
}

const FERRAMENTAS = [
  {
    name: 'registrar_lancamento',
    description: 'Anota um gasto ou recebimento que a pessoa contou. Fica salvo na hora.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['gasto', 'receita'] },
        valor: { type: 'number', description: 'Valor em reais, positivo' },
        categoria: { type: 'string', enum: CATS },
        descricao: { type: 'string', description: 'Descrição curta: almoço, uber, salário' },
        data: { type: 'string', description: 'AAAA-MM-DD; omita se for hoje' },
      },
      required: ['tipo', 'valor', 'categoria'],
    },
  },
  {
    name: 'simular_compra',
    description: 'Calcula o impacto de uma compra que a pessoa está pensando em fazer: limite de hoje, dias de limite, atraso nas metas e data do próximo pagamento. Não registra nada.',
    input_schema: {
      type: 'object',
      properties: { valor: { type: 'number', description: 'Preço em reais' }, item: { type: 'string', description: 'O que é, ex: tênis' } },
      required: ['valor'],
    },
  },
];

// ─── conversa com a IA (com as ferramentas) ──────────────────
async function conversar(S, conteudoUsuario, ctx) {
  const mensagens = [{ role: 'user', content: conteudoUsuario }];
  for (let rodada = 0; rodada < 4; rodada++) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, system: instrucoes(S, ctx.agora), tools: FERRAMENTAS, messages: mensagens }),
    });
    const data = await resp.json();
    if (!resp.ok) { console.error('Erro Anthropic:', JSON.stringify(data)); return 'Deu um probleminha aqui do meu lado. Tenta de novo em instantes?'; }
    const usos = (data.content || []).filter((b) => b.type === 'tool_use');
    if (!usos.length) return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    mensagens.push({ role: 'assistant', content: data.content });
    const resultados = [];
    for (const u of usos) {
      let saida;
      try { saida = await executar(u.name, u.input || {}, S, ctx); } catch (e) { console.error(e); saida = { erro: 'falhou' }; }
      resultados.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(saida) });
    }
    mensagens.push({ role: 'user', content: resultados });
  }
  return 'Anotado!';
}

async function executar(nome, x, S, ctx) {
  if (nome === 'simular_compra') {
    const valor = Number(x.valor);
    if (!(valor > 0)) return { erro: 'valor_invalido' };
    return simularCompra(S, valor, ctx.agora);
  }
  if (nome === 'registrar_lancamento') {
    const valor = Math.round(Number(x.valor) * 100) / 100;
    if (!(valor > 0)) return { erro: 'valor_invalido' };
    let ts = ctx.agora;
    if (x.data && /^\d{4}-\d{2}-\d{2}$/.test(x.data) && x.data !== isoDia(ctx.agora)) {
      const [yy, mm, dd] = x.data.split('-').map(Number);
      const t = meioDia(yy, mm - 1, dd);
      if (t <= ctx.agora && ctx.agora - t < 400 * 86400000) ts = t;
    }
    const p = partes(ts);
    const tx = {
      id: 'w' + ctx.msgId.slice(-10).replace(/[^A-Za-z0-9]/g, '') + ctx.contador++,
      tipo: x.tipo === 'receita' ? 'receita' : 'gasto',
      v: valor,
      cat: CATS.includes(x.categoria) ? x.categoria : 'outros',
      desc: String(x.descricao || '').slice(0, 60),
      ts,
      mk: mesKey(p.y, p.m),
      via: 'whatsapp',
    };
    const { error } = await supabase.from('whatsapp_inbox').insert({ id: tx.id, user_id: ctx.userId, tx });
    if (error && error.code !== '23505') { console.error(error); return { erro: 'nao_salvou' }; }
    S.txs = (S.txs || []).concat([tx]); // para o "quanto ainda dá hoje" já considerar
    const h = calcularHoje(S, ctx.agora);
    return { salvo: true, tipo: tx.tipo, valor: brl(valor), categoria: NOME_CAT[tx.cat], data: isoDia(ts), pode_gastar_hoje_ainda: h.semDados ? null : brl(Math.max(0, h.resta)), passou_do_limite_hoje: !h.semDados && h.resta < 0 ? brl(-h.resta) : null };
  }
  return { erro: 'desconhecida' };
}

// ─── WhatsApp: enviar, baixar mídia, transcrever ─────────────
async function enviar(para, texto) {
  const r = await fetch(GRAPH + '/' + process.env.WHATSAPP_PHONE_NUMBER_ID + '/messages', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: para, type: 'text', text: { body: String(texto).slice(0, 4000) } }),
  });
  if (!r.ok) console.error('Erro ao enviar WhatsApp:', r.status, await r.text());
}

async function baixarMidia(id) {
  const info = await fetch(GRAPH + '/' + id, { headers: { Authorization: 'Bearer ' + process.env.WHATSAPP_TOKEN } }).then((r) => r.json());
  if (!info || !info.url) throw new Error('midia_sem_url');
  const r = await fetch(info.url, { headers: { Authorization: 'Bearer ' + process.env.WHATSAPP_TOKEN } });
  if (!r.ok) throw new Error('midia_' + r.status);
  return { buffer: Buffer.from(await r.arrayBuffer()), mime: (info.mime_type || '').split(';')[0] };
}

async function transcrever(buffer, mime) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime || 'audio/ogg' }), 'audio.ogg');
  form.append('model', 'whisper-1');
  form.append('language', 'pt');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY }, body: form });
  const data = await r.json();
  if (!r.ok) throw new Error('transcricao: ' + JSON.stringify(data));
  return String(data.text || '').trim();
}

// ─── ligação do número com a conta ───────────────────────────
// O botão do app manda "Oi, Avanzi! 👋" com um código escondido em caracteres invisíveis.
function lerCodigoInvisivel(texto) {
  const m = String(texto || '').match(/⁠([​‌]+)⁠/);
  if (!m) return null;
  const bits = m[1].split('').map((c) => (c === '‌' ? '1' : '0')).join('');
  const ALFA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += ALFA[parseInt(bits.slice(i, i + 5), 2)];
  return out || null;
}
function lerCodigoVisivel(texto) {
  const m = String(texto || '').toUpperCase().match(/\b([A-HJ-NP-Z2-9]{6})\b/);
  return m ? m[1] : null;
}

async function tentarConectar(telefone, texto) {
  const codigos = [lerCodigoInvisivel(texto), lerCodigoVisivel(texto)].filter(Boolean);
  for (const codigo of codigos) {
    const { data } = await supabase.from('whatsapp_pending').select('user_id, created_at').eq('token', codigo).maybeSingle();
    if (!data) continue;
    if (Date.now() - new Date(data.created_at).getTime() > 30 * 60000) continue; // código vale 30 minutos
    await supabase.from('whatsapp_links').delete().eq('user_id', data.user_id);
    await supabase.from('whatsapp_links').upsert({ phone: telefone, user_id: data.user_id });
    await supabase.from('whatsapp_pending').delete().eq('token', codigo);
    return data.user_id;
  }
  return null;
}

async function ehPlus(userId) {
  const { data: u } = await supabase.auth.admin.getUserById(userId);
  const email = u && u.user && u.user.email ? u.user.email.toLowerCase() : null;
  if (!email) return false;
  const { data } = await supabase.from('subscribers').select('premium_ate, status').eq('email', email).maybeSingle();
  if (!data) return false;
  return data.status === 'authorized' || (!!data.premium_ate && new Date(data.premium_ate) > new Date());
}

async function dadosDoUsuario(userId) {
  const { data } = await supabase.from('user_data').select('data').eq('user_id', userId).maybeSingle();
  const S = (data && data.data) || {};
  S.txs = S.txs || [];
  // inclui o que já chegou pelo WhatsApp e o app ainda não puxou
  const { data: caixa } = await supabase.from('whatsapp_inbox').select('tx').eq('user_id', userId);
  const ids = new Set(S.txs.map((t) => t.id));
  (caixa || []).forEach((c) => { if (c.tx && !ids.has(c.tx.id)) S.txs.push(c.tx); });
  return S;
}

// ─── tratar uma mensagem ─────────────────────────────────────
async function tratar(msg) {
  const telefone = msg.from;
  const agora = Date.now();

  // evita responder duas vezes se o WhatsApp reenviar a mesma mensagem
  const { error: dup } = await supabase.from('whatsapp_msgs').insert({ id: msg.id });
  if (dup) return;

  const texto = msg.type === 'text' ? (msg.text && msg.text.body) || '' : '';

  // 1) conexão pelo botão do app
  if (texto) {
    const conectou = await tentarConectar(telefone, texto);
    if (conectou) {
      const S = await dadosDoUsuario(conectou);
      const nome = (S.usuario && S.usuario !== 'Você') ? ', ' + S.usuario.split(' ')[0] : '';
      await enviar(telefone, 'Conectado' + nome + '! ✨ Agora é só me mandar seus gastos do jeito que você fala, tipo "gastei 32 no almoço", ou até um áudio. E antes de comprar algo, me pergunta: "posso comprar um tênis de 300?"');
      return;
    }
  }

  // 2) número ainda não ligado a nenhuma conta
  const { data: link } = await supabase.from('whatsapp_links').select('user_id').eq('phone', telefone).maybeSingle();
  if (!link) {
    await enviar(telefone, 'Oi! 👋 Para eu anotar seus gastos, abre o app Avanzi (avanziapp.com.br), toca em "Anote pelo WhatsApp" e manda a mensagem que aparecer. É rapidinho.');
    return;
  }
  const userId = link.user_id;

  if (process.env.WHATSAPP_SO_PLUS === '1' && !(await ehPlus(userId))) {
    await enviar(telefone, 'O Avanzi no WhatsApp faz parte do Avanzi Plus. Dá para assinar pelo app, no Pix, e libera na hora. ✨');
    return;
  }

  // 3) monta o que a pessoa disse (texto, áudio ou foto)
  let conteudo;
  if (msg.type === 'text') {
    conteudo = texto.replace(/[​‌⁠]/g, '').trim();
  } else if (msg.type === 'audio') {
    if (!process.env.OPENAI_API_KEY) { await enviar(telefone, 'Ainda não consigo ouvir áudios por aqui. Me manda por texto, tipo "gastei 32 no almoço"? 🙏'); return; }
    const { buffer, mime } = await baixarMidia(msg.audio.id);
    const fala = await transcrever(buffer, mime);
    if (!fala) { await enviar(telefone, 'Não consegui entender o áudio. Tenta de novo ou manda por texto?'); return; }
    conteudo = fala;
  } else if (msg.type === 'image') {
    const { buffer, mime } = await baixarMidia(msg.image.id);
    const tipo = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime) ? mime : 'image/jpeg';
    conteudo = [
      { type: 'image', source: { type: 'base64', media_type: tipo, data: buffer.toString('base64') } },
      { type: 'text', text: (msg.image.caption || 'A pessoa mandou esta foto. Se for um produto com preço, ela quer saber se pode comprar. Se for um comprovante ou nota, anote o gasto.').slice(0, 500) },
    ];
  } else {
    await enviar(telefone, 'Por enquanto eu entendo texto, áudio e foto. Me manda "gastei 32 no almoço" que eu anoto. 😉');
    return;
  }
  if (!conteudo || (typeof conteudo === 'string' && !conteudo)) return;

  const S = await dadosDoUsuario(userId);
  const resposta = await conversar(S, conteudo, { agora, userId, msgId: msg.id, contador: 0 });
  if (resposta) await enviar(telefone, resposta);
}

// ─── entrada ─────────────────────────────────────────────────
function lerCorpo(req) {
  return new Promise((ok, erro) => { const partes = []; req.on('data', (c) => partes.push(c)); req.on('end', () => ok(Buffer.concat(partes))); req.on('error', erro); });
}

export default async function handler(req, res) {
  // a Meta confere o endereço uma vez, quando você salva o webhook
  if (req.method === 'GET') {
    const q = req.query || {};
    if (q['hub.mode'] === 'subscribe' && process.env.WHATSAPP_VERIFY_TOKEN && q['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(q['hub.challenge']);
    }
    return res.status(403).send('forbidden');
  }
  if (req.method !== 'POST') return res.status(405).end();

  const bruto = await lerCorpo(req);
  const segredo = process.env.WHATSAPP_APP_SECRET;
  if (segredo) {
    const esperado = 'sha256=' + crypto.createHmac('sha256', segredo).update(bruto).digest('hex');
    const recebido = String(req.headers['x-hub-signature-256'] || '');
    if (recebido.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(recebido), Buffer.from(esperado))) {
      return res.status(401).send('assinatura_invalida');
    }
  }

  let corpo = {};
  try { corpo = JSON.parse(bruto.toString('utf8') || '{}'); } catch (e) { return res.status(400).end(); }

  const mensagens = [];
  (corpo.entry || []).forEach((e) => (e.changes || []).forEach((c) => ((c.value && c.value.messages) || []).forEach((m) => mensagens.push(m))));

  for (const m of mensagens) {
    try { await tratar(m); }
    catch (e) {
      console.error('Erro WhatsApp:', e);
      try { await enviar(m.from, 'Deu um probleminha aqui do meu lado. Tenta de novo em instantes?'); } catch (e2) {}
    }
  }
  return res.status(200).json({ ok: true });
}
