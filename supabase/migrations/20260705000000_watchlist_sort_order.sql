alter table watchlist
  add column if not exists sort_order int not null default 0;

update watchlist set sort_order = id where sort_order = 0;
