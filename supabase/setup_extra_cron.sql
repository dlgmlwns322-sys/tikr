-- 티커 앱 v9 보조 수집(tikr-extra) 크론 — VIX(FRED)·종목 이름(KIS) (2026-10-01)
-- 실행: supabase db query --linked -f supabase/setup_extra_cron.sql  (다시 실행해도 같은 이름 잡은 덮어쓴다)
-- 키: 이 파일(공개 저장소)엔 없다. 기존 크론(stock-analysis-macro-poll) 명령의 service_role 키를 DB 안에서 꺼내 넣는다.
-- 시각: 매일 13:10 UTC(22:10 KST) — 전날 VIX 종가가 FRED에 올라온 뒤. 이름은 빠진 종목만(보통 0건이라 바로 끝남).
do $$
declare
  k text;
begin
  select substring(command from 'Bearer ([^''" ]+)') into k
    from cron.job where jobname = 'stock-analysis-macro-poll';
  if k is null or length(k) < 100 then
    raise exception 'service_role 키를 찾지 못했습니다(stock-analysis-macro-poll 명령)';
  end if;
  perform cron.schedule('tikr-extra-daily', '10 13 * * *', format(
    $c$select net.http_post(url := %L, body := %L::jsonb, headers := jsonb_build_object('Authorization', %L, 'Content-Type', 'application/json'), timeout_milliseconds := 150000)$c$,
    'https://rxaaouywglshpommdxnb.supabase.co/functions/v1/tikr-extra', '{"job":"daily"}', 'Bearer ' || k));
end $$;

-- 확인(키는 길이만): select jobname, schedule, active, length(substring(command from 'Bearer ([^''" ]+)')) as key_len from cron.job where jobname = 'tikr-extra-daily';
-- 끄기:              select cron.unschedule('tikr-extra-daily');
