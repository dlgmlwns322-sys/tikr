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
