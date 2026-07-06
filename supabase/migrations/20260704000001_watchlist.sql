create table if not exists watchlist (
  id bigint generated always as identity primary key,
  symbol text not null unique,
  market text not null default 'nasdaq',
  added_at timestamptz not null default now()
);

insert into watchlist (symbol, market) values
  ('AAPL', 'nasdaq'),
  ('NVDA', 'nasdaq'),
  ('TSLA', 'nasdaq'),
  ('MSFT', 'nasdaq')
on conflict (symbol) do nothing;
