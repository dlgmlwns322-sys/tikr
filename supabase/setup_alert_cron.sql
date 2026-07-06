-- Supabase SQL Editor에서 한 번만 실행 (stock-analysis 프로젝트)
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 1분마다 stock-alert 함수 호출 (내부에서 종목별 하락률 체크 + 하루 1회만 알림)
-- <PROJECT_REF>, <SERVICE_ROLE_KEY>는 Supabase 프로젝트 설정 값으로 교체
select cron.schedule(
  'stock-analysis-alert-poll',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/stock-alert',
    headers := jsonb_build_object('Authorization', 'Bearer <SERVICE_ROLE_KEY>')
  );
  $$
);

-- 스케줄 확인: select * from cron.job;
-- 스케줄 삭제: select cron.unschedule('stock-analysis-alert-poll');

-- ══════════════════════════════════════════════════════════════════
-- 아래는 2026-07-07 추가: 홈 화면 지수(KOSPI/KOSDAQ)·개별 국내종목·환율·코인이
-- 자동 갱신 크론이 없어서 며칠 전 값에 멈춰있던 문제(사용자가 실시간과 다르다고 제보) 해결용.
-- ══════════════════════════════════════════════════════════════════

-- 5분마다: 코스피·코스닥 지수 + 국내 개별종목(watchlist) + 원/달러 환율 + 코인(업비트·바이낸스) 순차 갱신
-- (macro-poll 내부에서 KIS 관련 호출을 await로 직렬 실행해 "초당 거래건수 초과" 회피)
select cron.schedule(
  'stock-analysis-macro-poll',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/macro-poll',
    headers := jsonb_build_object('Authorization', 'Bearer <SERVICE_ROLE_KEY>')
  );
  $$
);

-- 하루 1번(자정): 한국 국고채(ECOS)·미국 국채(FRED) — 둘 다 하루 단위로만 갱신되는 데이터라 이 이상 자주 돌 필요 없음
select cron.schedule(
  'stock-analysis-daily-bond-poll',
  '0 0 * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/bond-korea',
    headers := jsonb_build_object('Authorization', 'Bearer <SERVICE_ROLE_KEY>')
  );
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/bond-us',
    headers := jsonb_build_object('Authorization', 'Bearer <SERVICE_ROLE_KEY>')
  );
  $$
);

-- 하루 1번(자정+10분): 금·유가 — GoldAPI 무료 티어가 월 100회 한도라 반드시 하루 1번으로 제한해야 함
-- (5분마다 돌리면 하루 안에 무료 한도 소진됨. 유가 OilPriceAPI는 월 200회라 상대적으로 여유 있음)
select cron.schedule(
  'stock-analysis-daily-commodity-poll',
  '10 0 * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/commodity-quote',
    headers := jsonb_build_object('Authorization', 'Bearer <SERVICE_ROLE_KEY>')
  );
  $$
);
