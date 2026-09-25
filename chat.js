// POST /api/chat
// Recebe { email, mensagens: [{ role, content }], hoje } e conversa com a IA (Claude Haiku).
// Só funciona para quem é Aprumo Plus, o que protege o crédito da API.
// Devolve { texto, acoes: [{ tipo, dados }] } para o app mostrar os cartões de confirmação.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const CATS = ['alimentacao', 'transporte', 'lazer', 'moradia', 'saude', 'roupas', 'mercado', 'outros'];

const TOOLS = [
  {
    name: 'registrar_lancamento',
    description: 'Registra um gasto ou uma receita que o usuário contou. O app mostra um cartão para o usuário confirmar antes de salvar.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['gasto', 'receita'] },
        valor: { type: 'number', description: 'Valor em reais, sempre positivo' },
        categoria: { type: 'string', enum: CATS },
        descricao: { type: 'string', description: 'Descrição curta, ex: almoço, uber, salário' },
        data: { type: 'string', description: 'Data no formato AAAA-MM-DD' },
      },
      required: ['tipo', 'valor', 'categoria'],
    },
  },
  {
    name: 'criar_meta',
    description: 'Cria uma meta de economia (algo que o usuário quer juntar dinheiro para comprar ou fazer). O app mostra um cartão para confirmar.',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome curto da meta, ex: Viagem, Reserva de emergência' },
        total: { type: 'number', description: 'Quanto quer juntar no total, em reais' },
        mensal: { type: 'number', description: 'Quanto pretende guardar por mês, em reais (opcional)' },
        emoji: { type: 'string', description: 'Um emoji que combine com a meta (opcional)' },
      },
      required: ['nome', 'total'],
    },
  },
  {
    name: 'definir_limite',
    description: 'Define um teto de gasto mensal para uma categoria. O app mostra um cartão para confirmar.',
    input_schema: {
      type: 'object',
      properties: {
        categoria: { type: 'string', enum: CATS },
        valor: { type: 'number', description: 'Valor máximo por mês, em reais' },
      },
      required: ['categoria', 'valor'],
    },
  },
];

function regras(hoje) {
  return [
    'Você é o organizador particular do Aprumo, um app brasileiro de finanças pessoais para quem está começando do zero.',
    'Hoje é ' + hoje + ' (formato AAAA-MM-DD).',
    'Categorias possíveis (use exatamente um destes ids): ' + CATS.join(', ') + '. Na dúvida, use "outros".',
    'Quando o usuário contar um gasto ou recebimento com valor, chame registrar_lancamento. Se ele citar vários na mesma mensagem, chame uma vez para cada.',
    'Quando ele quiser juntar dinheiro para algo com um valor total, chame criar_meta.',
    'Quando ele quiser um limite mensal para uma categoria e já tiver dito categoria e valor, chame definir_limite. Se faltar algo, pergunte.',
    'Se faltar o valor, não chame ferramenta nenhuma: pergunte de forma curta. Nunca invente valores.',
    'Converta datas relativas (hoje, ontem, anteontem, sexta passada) para AAAA-MM-DD usando a data de hoje.',
    'Sempre escreva também uma frase curta e natural dizendo o que entendeu. O app mostra um cartão para o usuário confirmar, então nunca diga que já salvou.',
    'Se a mensagem não for sobre dinheiro, responda com gentileza, em uma frase, que você ajuda com gastos, receitas, metas e limites.',
    'Escreva em português do Brasil, em texto simples, sem markdown, sem listas e sem asteriscos, como uma mensagem curta de WhatsApp.',
  ].join(' ');
}

async function ehPlus(email) {
  const { data } = await supabase
    .from('subscribers')
    .select('premium_ate, status')
    .eq('email', email)
    .maybeSingle();
  if (!data) return false;
  const dentroDoPrazo = !!data.premium_ate && new Date(data.premium_ate) > new Date();
  return data.status === 'authorized' || dentroDoPrazo;
}

// A API espera conversa começando pelo usuário e sem duas mensagens seguidas do mesmo lado
function organizar(mensagens) {
  const lista = [];
  mensagens.slice(-14).forEach((m) => {
    const role = m && m.role === 'assistant' ? 'assistant' : 'user';
    const content = String((m && m.content) || '').slice(0, 1000).trim();
    if (!content) return;
    const ultima = lista[lista.length - 1];
    if (ultima && ultima.role === role) ultima.content += '\n' + content;
    else lista.push({ role, content });
  });
  while (lista.length && lista[0].role !== 'user') lista.shift();
  return lista;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'method_not_allowed' });

  const { email, mensagens, hoje } = req.body || {};
  if (!email || !Array.isArray(mensagens)) return res.status(400).json({ erro: 'dados_invalidos' });

  try {
    if (!(await ehPlus(email))) return res.status(403).json({ erro: 'requer_plus' });

    const historico = organizar(mensagens);
    if (!historico.length) return res.status(400).json({ erro: 'sem_mensagem' });

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: regras(hoje || new Date().toISOString().slice(0, 10)),
        tools: TOOLS,
        messages: historico,
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error('Erro Anthropic:', data);
      return res.status(500).json({ erro: 'ia_error' });
    }

    let texto = '';
    const acoes = [];
    (data.content || []).forEach((b) => {
      if (b.type === 'text') texto += b.text;
      if (b.type === 'tool_use') acoes.push({ tipo: b.name, dados: b.input });
    });

    return res.status(200).json({ texto: texto.trim(), acoes });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: 'server_error' });
  }
}
