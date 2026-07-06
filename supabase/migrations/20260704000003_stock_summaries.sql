create table if not exists stock_summaries (
  id bigint generated always as identity primary key,
  symbol text not null,
  summary text not null,
  sources jsonb not null default '{}'::jsonb,
  model text not null,
  created_at timestamptz not null default now()
);

create index if not exists stock_summaries_symbol_created_at_idx
  on stock_summaries (symbol, created_at desc);
