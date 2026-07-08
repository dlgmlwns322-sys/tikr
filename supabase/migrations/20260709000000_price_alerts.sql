-- 종목/지수/환율/원자재/코인/채권 등 앱에서 보이는 모든 심볼에 퍼센트·금액 알림을 여러 개 걸 수 있는 통합 테이블.
-- 기존 watchlist.alert_threshold_pct(나스닥 종목 전용, 1개 고정)를 대체한다.
create table if not exists price_alerts (
  id bigint generated always as identity primary key,
  symbol text not null,
  kind text not null check (kind in ('pct', 'price')),
  direction text not null check (direction in ('above', 'below')),
  threshold numeric not null,
  enabled boolean not null default true,
  -- pct 알림: 세션(거래일)당 1회만 발동 — 마지막으로 발동한 세션 키(YYYY-MM-DD, 심볼 마켓 기준 로컬 날짜)를 기록해두고
  -- 다음 세션이 되면 다시 발동 가능하게 함. price 알림은 1회성이라 발동 즉시 enabled=false로 꺼버리고 이 값은 안 씀.
  last_fired_session text,
  created_at timestamptz not null default now()
);

create index if not exists price_alerts_symbol_idx on price_alerts (symbol) where enabled;

-- 기존 watchlist.alert_threshold_pct 값을 새 테이블로 그대로 이관 (지금까지 전부 기본값 -3%)
insert into price_alerts (symbol, kind, direction, threshold, enabled)
select symbol, 'pct', 'below', alert_threshold_pct, true
from watchlist
where alert_threshold_pct is not null
on conflict do nothing;
