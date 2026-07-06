create table if not exists quote_history (
  id bigint generated always as identity primary key,
  symbol text not null,
  price numeric not null,
  change numeric,
  percent_change numeric,
  fetched_at timestamptz not null default now()
);

create index if not exists quote_history_symbol_fetched_at_idx
  on quote_history (symbol, fetched_at desc);
