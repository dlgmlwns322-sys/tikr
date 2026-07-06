create table if not exists kis_tokens (
  id smallint primary key default 1,
  access_token text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint kis_tokens_singleton check (id = 1)
);
