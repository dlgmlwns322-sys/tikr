alter table watchlist
  add column if not exists alert_threshold_pct numeric not null default -3;

create table if not exists stock_alert_log (
  symbol text not null,
  alert_date date not null,
  percent_change numeric not null,
  created_at timestamptz not null default now(),
  primary key (symbol, alert_date)
);
