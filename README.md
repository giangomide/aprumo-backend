# Backend de assinatura do Aprumo

Três funções que rodam no Vercel e conversam com o Mercado Pago e o Supabase
para liberar o Aprumo Plus automaticamente quando alguém assina.

## O que cada arquivo faz

- `api/criar-assinatura.js` — o app chama isso quando a pessoa toca em "Assinar".
  Cria a assinatura no Mercado Pago e devolve o link de pagamento.
- `api/webhook.js` — o Mercado Pago chama isso sozinho quando o pagamento é
  aprovado (ou cancelado). É aqui que o Plus é liberado de verdade.
- `api/status.js` — o app chama isso pra saber se um email está com o Plus ativo.
- `schema.sql` — a tabela do banco de dados (Supabase) onde fica salvo quem é assinante.

## Passo a passo pra colocar no ar

### 1. Crie um projeto no Supabase (banco de dados grátis)
1. Acesse supabase.com e crie uma conta / novo projeto (fica pronto em ~2 minutos).
2. No painel do projeto, vá em **SQL Editor**, cole o conteúdo de `schema.sql` e clique em **Run**.
3. Vá em **Project Settings → API** e copie dois valores: **Project URL** e a
   **service_role key** (não a "anon" — precisa ser a service_role, que tem mais permissão).

### 2. Pegue as credenciais do Mercado Pago
Se ainda não fez: painel do Mercado Pago Developers → sua aplicação →
**Credenciais de teste** → copie o **Access Token** (começa com `TEST-`).

### 3. Suba esse código pro Vercel
A forma mais simples, sem usar linha de comando:
1. Crie um repositório novo no GitHub e suba esta pasta inteira nele
   (pode arrastar os arquivos direto pela interface do GitHub, em "Add file → Upload files").
2. Em vercel.com, clique em **Add New → Project**, conecte sua conta do GitHub
   e escolha esse repositório.
3. Antes de clicar em Deploy, abra **Environment Variables** e adicione as 4 variáveis
   do arquivo `.env.example` (com seus valores reais, não os de exemplo):
   `MP_ACCESS_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `APP_URL`.
4. Clique em **Deploy**. Em menos de um minuto o Vercel te dá uma URL tipo
   `https://aprumo-backend.vercel.app`.

### 4. Configure o webhook no Mercado Pago
No painel do Mercado Pago Developers, dentro da sua aplicação, vá em **Webhooks**
e cadastre a URL: `https://SEU-BACKEND.vercel.app/api/webhook`
(troque pelo domínio que o Vercel te deu). Marque o evento **Assinaturas** (preapproval).

### 5. Me avise quando tiver essa URL do backend
Assim que você tiver o link do backend publicado (ex: `https://aprumo-backend.vercel.app`),
me manda ele que eu conecto o app do Aprumo pra usar esse servidor de verdade
em vez do botão de teste que só simula a assinatura.

## Testando antes de valer

Com as credenciais **de teste** do Mercado Pago (as que começam com `TEST-`),
os pagamentos não são cobrados de verdade — o Mercado Pago te dá números de
cartão de teste pra simular a compra. Só depois de tudo validado é que você
troca pelas credenciais de produção (aí sim é dinheiro de verdade entrando).
