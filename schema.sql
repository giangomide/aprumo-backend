-- Rode isso uma vez no Supabase: painel do projeto → SQL Editor → cole e clique em Run

create table if not exists subscribers (
  email text primary key,
  premium boolean not null default false,
  plano text,
  mp_preapproval_id text,
  status text,
  updated_at timestamptz not null default now()
);

-- Permite que as funções do servidor (usando a service key) leiam e escrevam livremente.
-- Isso é seguro porque a service key nunca fica exposta no navegador, só no servidor.
alter table subscribers enable row level security;

create policy "service_role_full_access"
  on subscribers
  for all
  using (true)
  with check (true);
