-- 티커 점수 수집기(tikr-collect) 크론 — 점수 엔진 적용 ④ (2026-10-01)
-- 실행: supabase db query --linked -f supabase/setup_score_cron.sql  (다시 실행해도 같은 이름 잡은 덮어쓴다)
-- 키: 이 파일(공개 저장소)엔 없다. 기존 크론(stock-analysis-macro-poll) 명령의 service_role 키를
--     DB 안에서 꺼내 새 명령에 넣는다 — 화면·저장소에 남지 않는다. 기존 크론과 같은 방식(명령 안에 키).
-- 시각: cron.timezone = GMT → 아래는 UTC. KST = UTC+9.
--   kr    평일 16:05~16:59 KST = 월~금 07:05~07:59 UTC
--   us    화~토 06:35~07:27 KST = 월~금 21:35~22:27 UTC (시가 바뀌어 잡 두 개)
--         마지막 호출을 07:27로 — 110초 안에 끝나 토 07:30 fund와 겹치지 않는다(KIS 동시 호출 방지, 2026-10-01 검토)
--   fund  토   07:30~08:29 KST = 금   22:30~23:29 UTC (시가 바뀌어 잡 두 개)
-- 2분마다 부른다. 함수는 한 번에 110초 안에서 작업 대기열을 빌려 처리하고, 남은 몫은 다음 호출이 잇는다.
-- pg_net 타임아웃 150초(함수 벽시계 제한과 같음).
do $$
declare
  k text;
  u constant text := 'https://rxaaouywglshpommdxnb.supabase.co/functions/v1/tikr-collect';
  j record;
begin
  select substring(command from 'Bearer ([^''" ]+)') into k
    from cron.job where jobname = 'stock-analysis-macro-poll';
  if k is null or length(k) < 100 then
    raise exception 'service_role 키를 찾지 못했습니다(stock-analysis-macro-poll 명령)';
  end if;
  for j in
    select * from (values
      ('tikr-score-kr',     '5-59/2 7 * * 1-5',   'kr'),
      ('tikr-score-us-a',   '35-59/2 21 * * 1-5', 'us'),
      ('tikr-score-us-b',   '1-27/2 22 * * 1-5',  'us'),
      ('tikr-score-fund-a', '30-58/2 22 * * 5',   'fund'),
      ('tikr-score-fund-b', '0-28/2 23 * * 5',    'fund')
    ) v(name, sched, job)
  loop
    perform cron.schedule(j.name, j.sched, format(
      $c$select net.http_post(url := %L, body := %L::jsonb, headers := jsonb_build_object('Authorization', %L, 'Content-Type', 'application/json'), timeout_milliseconds := 150000)$c$,
      u, json_build_object('job', j.job)::text, 'Bearer ' || k));
  end loop;
end $$;

-- 확인(키는 길이만): select jobname, schedule, active, length(substring(command from 'Bearer ([^''" ]+)')) as key_len from cron.job where jobname like 'tikr-score-%' order by jobname;
-- 끄기:              select cron.unschedule(jobname) from cron.job where jobname like 'tikr-score-%';
