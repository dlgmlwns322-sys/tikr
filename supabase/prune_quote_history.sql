-- ════════════════════════════════════════════════════════════════
-- quote_history egress 최적화: 오래된 1분 데이터 다운샘플 + 일일 자동 정리
-- 목적: 1분 폴링으로 quote_history가 종목당 수만 행까지 커져, 앱이 기간 조회할 때
--       응답이 무거워 무료 egress(월 5GB)를 갉아먹음. 최근 3일치만 1분 그대로 두고,
--       그보다 오래된 건 "하루 1개(그날 마지막 시세)"로 줄인다. 차트 장기추이엔 하루 1점이면 충분.
-- 적용: Supabase 정지 해제(청구주기 리셋 or Pro) 후 SQL Editor에서 1회 실행 → 그다음 하단 cron이 매일 자동.
-- ════════════════════════════════════════════════════════════════

-- 1) 즉시 1회 정리: 3일 이전 데이터를 심볼×일자별 마지막 1행만 남기고 삭제
with keep as (
  select distinct on (symbol, (fetched_at at time zone 'Asia/Seoul')::date) id
  from quote_history
  where fetched_at < now() - interval '3 days'
  order by symbol, (fetched_at at time zone 'Asia/Seoul')::date, fetched_at desc
)
delete from quote_history
where fetched_at < now() - interval '3 days'
  and id not in (select id from keep);

-- 2) 매일 새벽 3시(KST=UTC 18시) 자동 정리 크론 등록 (위와 동일 로직)
select cron.schedule(
  'tikr-prune-quote-history',
  '0 18 * * *',
  $$
  with keep as (
    select distinct on (symbol, (fetched_at at time zone 'Asia/Seoul')::date) id
    from quote_history
    where fetched_at < now() - interval '3 days'
    order by symbol, (fetched_at at time zone 'Asia/Seoul')::date, fetched_at desc
  )
  delete from quote_history
  where fetched_at < now() - interval '3 days'
    and id not in (select id from keep);
  $$
);

-- (되돌리기) select cron.unschedule('tikr-prune-quote-history');
