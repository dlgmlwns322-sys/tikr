-- 티커 점수 수집기(Edge Function tikr-collect)용 — 볼트 「점수기준서_v1」 v1.5 §10 · 「수집기_설계」.
-- 엔진 마이그레이션(20260930000000) 다음에 적용. 처음 적용 전용(엄격 생성, 운영 데이터 없음).
-- 원칙
--   · 수집기는 service_role로 public.tikr_collect_* 네 함수만 부른다(tikr_score 스키마는 API 비노출, 앱 키로는 실행 불가).
--   · 전송량: 큰 데이터를 돌려주지 않는다 — 넣고 요약만 돌려준다(응답 수 KB 이하).
--   · 작업 대기열: (작업, 기준일)마다 종목·시리즈 1행. 호출마다 조금씩 빌려 가고(임대 5분), 3번 빌려 가고도 못 끝내면 닫는다.

create table tikr_score.symbols (
  market      text not null check (market in ('US', 'KR')),
  symbol      text not null,
  excd        text check (excd in ('NAS', 'NYS', 'AMS')),   -- KIS 해외 거래소 코드(미국만)
  currency    text,                                        -- Finnhub 보고 통화(시총 대체 판정)
  currency_at timestamptz,
  primary key (market, symbol)
);

create table tikr_score.collect_task (
  job        text not null check (job in ('kr_px', 'us_px', 'us_check', 'fund', 'backfill')),
  d          date not null,                 -- 기준 거래일(backfill은 시작일)
  market     text not null check (market in ('US', 'KR')),
  symbol     text not null,                 -- 종목 코드 또는 시리즈('#COMP'·'#KOSPI'·'#KOSDAQ'·'#FX')
  status     text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  tries      int not null default 0,
  leased_at  timestamptz,
  retry_at   timestamptz,                   -- 재시도 대기(3분 × 시도 횟수) — 일시 장애에 시도 3번을 한꺼번에 쓰지 않게
  note       text,
  updated_at timestamptz not null default now(),
  primary key (job, d, market, symbol)
);

-- 지수·환율 충돌 기록: 겹침 창에서 같은 날짜 값이 끝까지 다름(최대 2회 재조회 뒤)
create table tikr_score.series_conflict (
  id         bigserial primary key,
  code       text not null,
  d          date not null,
  vals       double precision[] not null,
  resolution text not null,                 -- 충돌 → 직전 검증값 유지 / 충돌 → 산출 보류
  logged_at  timestamptz not null default now()
);

create table tikr_score.collect_log (
  id        bigserial primary key,
  job       text not null,
  d         date,
  summary   jsonb not null,
  logged_at timestamptz not null default now()
);

alter table tikr_score.symbols         enable row level security;
alter table tikr_score.collect_task    enable row level security;
alter table tikr_score.series_conflict enable row level security;
alter table tikr_score.collect_log     enable row level security;

-- 기준일 당시 구성원(엔진 compute_momentum과 같은 구간 규칙)
create or replace function tikr_score.members_on(p_market text, p_d date)
returns table (symbol text) language sql stable as $$
  select distinct u.symbol from tikr_score.universe u
  where u.market = p_market and u.active_from <= p_d and (u.active_to is null or p_d < u.active_to)
$$;

-- 작업 계획(이미 있는 행은 그대로 — 호출마다 불러도 된다). 새로 넣은 행 수를 돌려준다.
create or replace function tikr_score.plan_tasks(p_job text, p_d date)
returns int language plpgsql as $$
declare n int := 0;
begin
  if p_job = 'kr_px' then
    insert into tikr_score.collect_task (job, d, market, symbol)
    select 'kr_px', p_d, 'KR', x.s
      from (select unnest(array['#KOSPI', '#KOSDAQ', '#FX']) as s
            union select m.symbol from tikr_score.members_on('KR', p_d) m) x
    on conflict do nothing;
  elsif p_job = 'us_px' then
    insert into tikr_score.collect_task (job, d, market, symbol)
    select 'us_px', p_d, 'US', x.s
      from (select unnest(array['#COMP', '#FX']) as s
            union select m.symbol from tikr_score.members_on('US', p_d) m) x
    on conflict do nothing;
  elsif p_job = 'us_check' then
    -- 미국 봉 수집(us_px)이 끝난 뒤에만: 그날 봉이 있는 구성원
    if exists (select 1 from tikr_score.collect_task t
               where t.job = 'us_px' and t.d = p_d and t.status in ('pending', 'running')) then
      return 0;
    end if;
    insert into tikr_score.collect_task (job, d, market, symbol)
    select 'us_check', p_d, 'US', m.symbol from tikr_score.members_on('US', p_d) m
     where exists (select 1 from tikr_score.px_daily p where p.market = 'US' and p.symbol = m.symbol and p.d = p_d)
    on conflict do nothing;
  elsif p_job = 'fund' then
    insert into tikr_score.collect_task (job, d, market, symbol)
    select 'fund', p_d, x.market, x.symbol
      from (select 'US' as market, m.symbol from tikr_score.members_on('US', p_d) m
            union all select 'KR', m.symbol from tikr_score.members_on('KR', p_d) m) x
    on conflict do nothing;
  else
    return 0;   -- backfill은 public.tikr_collect_plan으로 명시 계획
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

-- 작업 빌리기: 대기 중(재시도 시각 지남)이거나 임대가 만료된(5분) 작업을 지수·환율 먼저 p_limit개.
-- 3번 빌려 가고도 못 끝낸 작업은 실패로 닫는다.
create or replace function tikr_score.lease_tasks(p_job text, p_d date, p_limit int)
returns table (market text, symbol text, tries int, note text) language plpgsql as $$
#variable_conflict use_column
begin
  update tikr_score.collect_task t
     set status = 'failed', leased_at = null, retry_at = null, updated_at = now(),
         note = left(coalesce(t.note || ' · ', '') || '시도 초과', 200)
   where t.job = p_job and t.d = p_d and t.tries >= 3
     and ((t.status = 'pending' and (t.retry_at is null or t.retry_at <= now()))
          or (t.status = 'running' and t.leased_at < now() - interval '5 minutes'));
  return query
  with c as (
    select t.market, t.symbol from tikr_score.collect_task t
     where t.job = p_job and t.d = p_d
       and ((t.status = 'pending' and (t.retry_at is null or t.retry_at <= now()))
            or (t.status = 'running' and t.leased_at < now() - interval '5 minutes'))
     order by (t.symbol like '#%') desc, t.market, t.symbol
     limit greatest(p_limit, 0)
     for update skip locked
  )
  update tikr_score.collect_task t
     set status = 'running', tries = t.tries + 1, leased_at = now(), retry_at = null, updated_at = now()
    from c
   where t.job = p_job and t.d = p_d and t.market = c.market and t.symbol = c.symbol
  returning t.market, t.symbol, t.tries, t.note;
end $$;

-- 지수 누락: 그 시장 종목 과반이 거래한 날인데 기준 지수 값이 없는 날(평가일 달력이 지수로 만들어지므로 누락 0이어야 한다)
create or replace function tikr_score.index_gaps(p_from date, p_to date)
returns table (code text, d date) language sql stable as $$
  with px as (
    select p.market, p.d, count(*) as n from tikr_score.px_daily p
     where p.d between p_from and p_to group by p.market, p.d
  ), mx as (select px.market, max(px.n) as mx from px group by px.market)
  select c.code, px.d
    from px join mx on mx.market = px.market
    cross join lateral unnest(case when px.market = 'US' then array['COMP'] else array['KOSPI', 'KOSDAQ'] end) as c(code)
   where px.n * 2 >= mx.mx
     and not exists (select 1 from tikr_score.bench_daily b where b.code = c.code and b.d = px.d)
   order by px.d, c.code
$$;

-- 확정 산출: 평가일 D의 두 시장 세션이 모두 확정(미 16:30 ET · 한 16:00 KST)되고 수집이 끝난 뒤,
-- 최근 21일 평가일 중 아직 확정되지 않은 날(시장별)을 계산한다(장애로 빠진 날도 함께 — 확정값은 덮어쓰지 않음).
--   · 기준 지수가 빠진 날은 그 시장·그 날짜만 보류(skipped)하고 나머지는 확정. 지수가 채워지면 다음 호출이 계산한다.
--   · 한 번에 p_max건(시장·날짜)까지만 — PostgREST 요청 제한(8초) 안에서 끝내고, 남으면 'partial'로 알려 다시 부르게 한다.
create or replace function tikr_score.confirm_days(p_d date, p_max int default 4)
returns jsonb language plpgsql as $$
declare
  e record; k int; n_rows int := 0; n_hold int := 0; n_done int := 0; n_left int := 0;
  days jsonb := '[]'::jsonb; skipped jsonb := '[]'::jsonb; miss jsonb;
begin
  if now() < greatest((p_d + time '16:30') at time zone 'America/New_York', (p_d + time '16:00') at time zone 'Asia/Seoul') then
    return jsonb_build_object('status', 'too_early');
  end if;
  if exists (select 1 from tikr_score.collect_task t
             where t.d = p_d and t.job in ('kr_px', 'us_px', 'us_check') and t.status in ('pending', 'running')) then
    return jsonb_build_object('status', 'collecting');
  end if;
  select coalesce(jsonb_agg(jsonb_build_array(g.code, g.d)), '[]'::jsonb) into miss
    from tikr_score.index_gaps(p_d - 20, p_d) g;

  for e in
    select c.d, m.market
      from tikr_score.eval_calendar c cross join (values ('US'), ('KR')) as m(market)
     where c.d between p_d - 20 and p_d
       and exists (select 1 from tikr_score.members_on(m.market, c.d))
       and not exists (select 1 from tikr_score.momentum_daily x where x.market = m.market and x.d = c.d)
     order by c.d, m.market
  loop
    if (e.market = 'US' and miss @> jsonb_build_array(jsonb_build_array('COMP', e.d)))
       or (e.market = 'KR' and (miss @> jsonb_build_array(jsonb_build_array('KOSPI', e.d))
                                or miss @> jsonb_build_array(jsonb_build_array('KOSDAQ', e.d)))) then
      skipped := skipped || jsonb_build_array(jsonb_build_array(e.market, e.d));
      continue;
    end if;
    if n_done >= greatest(coalesce(p_max, 4), 1) then
      n_left := n_left + 1;
      continue;
    end if;
    -- 시장이 연 날(기준 지수 값 있음)인데 구성원 봉이 없으면 '당일 시세 없음' 보류 — 이전 봉으로 조용히 계산되지 않게
    if exists (select 1 from tikr_score.bench_daily b
               where b.code = case when e.market = 'US' then 'COMP' else 'KOSPI' end and b.d = e.d) then
      insert into tikr_score.px_hold (market, symbol, d, reason, detail)
      select e.market, m.symbol, e.d, '당일 시세 없음', jsonb_build_object('by', 'confirm')
        from tikr_score.members_on(e.market, e.d) m
       where exists (select 1 from tikr_score.px_daily p where p.market = e.market and p.symbol = m.symbol and p.d < e.d)
         and not exists (select 1 from tikr_score.px_daily p where p.market = e.market and p.symbol = m.symbol and p.d = e.d)
      on conflict do nothing;
      get diagnostics k = row_count;
      n_hold := n_hold + k;
    end if;
    k := tikr_score.compute_momentum(e.market, e.d);
    n_rows := n_rows + k;
    n_done := n_done + 1;
    days := days || jsonb_build_array(jsonb_build_array(e.market, e.d, k));
  end loop;

  if n_left = 0 then
    perform tikr_score.prune((now() at time zone 'Asia/Seoul')::date);
    delete from tikr_score.collect_task    where updated_at < now() - interval '30 days';
    delete from tikr_score.collect_log     where logged_at  < now() - interval '90 days';
    delete from tikr_score.series_conflict where logged_at  < now() - interval '400 days';
  end if;
  return jsonb_build_object('status', case when n_left > 0 then 'partial' else 'confirmed' end,
                            'days', days, 'rows', n_rows, 'holds', n_hold, 'left', n_left,
                            'skipped', skipped, 'missing', miss);
end $$;

-- ── 수집기 전용 공개 함수(service_role만) ─────────────

create or replace function public.tikr_collect_lease(p_job text, p_d date, p_limit int default 8)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare planned int; tasks jsonb; remaining int;
begin
  if p_job is null or p_d is null then raise exception '작업·기준일 필요'; end if;
  planned := tikr_score.plan_tasks(p_job, p_d);
  select coalesce(jsonb_agg(jsonb_build_object(
           'market', l.market, 'symbol', l.symbol, 'tries', l.tries, 'note', l.note,
           'excd', s.excd, 'currency', s.currency, 'currency_at', s.currency_at,
           'last_d', case when p_job in ('kr_px', 'us_px') then   -- 이력이 없거나 오래 비었으면 수집기가 전체를 받는다
                       (select max(p.d) from tikr_score.px_daily p where p.market = l.market and p.symbol = l.symbol) end,
           'close', case when p_job = 'us_check' then
                      (select p.close from tikr_score.px_daily p where p.market = l.market and p.symbol = l.symbol and p.d = p_d) end)),
         '[]'::jsonb)
    into tasks
    from tikr_score.lease_tasks(p_job, p_d, least(greatest(coalesce(p_limit, 8), 1), 50)) l
    left join tikr_score.symbols s on s.market = l.market and s.symbol = l.symbol;
  select count(*) into remaining from tikr_score.collect_task t
   where t.job = p_job and t.d = p_d and t.status in ('pending', 'running');
  return jsonb_build_object('planned', planned, 'tasks', tasks, 'remaining', remaining);
end $$;

-- 넣기(한 번에 여러 종류 가능): px·series·conflicts·fund·symbols·holds·done·log
create or replace function public.tikr_collect_ingest(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  n_px int := 0; n_ser int := 0; n_hold int := 0; n_fund int := 0; n_done int := 0;
  adj jsonb := '[]'::jsonb; inc jsonb := '[]'::jsonb;
  px_full boolean := coalesce((p->>'px_full')::boolean, false);
  px_from date := (p->>'px_from')::date;
begin
  if jsonb_typeof(p) is distinct from 'object' then raise exception '객체 필요'; end if;

  -- 확정 일봉 [market, symbol, d, close, volume, amount]. 바뀐 행만 갱신.
  --   · 매일 수집(px_full 아님): 저장된 과거 종가(그 종목 마지막 저장일 제외 — 그날은 정정일 수 있음)와 다르면
  --     수정주가 변경(액면분할 등) → 그 종목은 아무것도 쓰지 않고 adjusted로 알린다. 수집기가 전체를 받아 px_full로 다시 보낸다
  --     (먼저 최근 구간만 덮어 버리면 전체 재수집이 실패했을 때 다시는 감지되지 않는다).
  --   · 전체 수집(px_full): px_from ~ 받은 마지막 날 사이에 저장돼 있는데 이번에 안 온 날짜가 있으면(창 누락 등)
  --     섞인 이력이 되지 않게 그 종목은 쓰지 않고 incomplete로 알린다(수집기가 재시도).
  if jsonb_typeof(p->'px') = 'array' then
    with x as (
      select e->>0 as market, e->>1 as symbol, (e->>2)::date as d, (e->>3)::float8 as close,
             (e->>4)::float8 as volume, (e->>5)::float8 as amount
        from jsonb_array_elements(p->'px') e
    ), rng as (
      select x.market, x.symbol, min(x.d) as mn, max(x.d) as mx from x group by x.market, x.symbol
    ), chg as (
      select distinct x.market, x.symbol from x
        join tikr_score.px_daily o on o.market = x.market and o.symbol = x.symbol and o.d = x.d
       where not px_full and abs(o.close / x.close - 1) > 1e-9
         and o.d < (select max(o2.d) from tikr_score.px_daily o2 where o2.market = x.market and o2.symbol = x.symbol)
    ), gap as (
      select distinct o.market, o.symbol from tikr_score.px_daily o
        join rng on rng.market = o.market and rng.symbol = o.symbol
       where px_full and o.d >= coalesce(px_from, rng.mn) and o.d <= rng.mx
         and not exists (select 1 from x where x.market = o.market and x.symbol = o.symbol and x.d = o.d)
    ), w as (
      select x.* from x
       where not exists (select 1 from chg where chg.market = x.market and chg.symbol = x.symbol)
         and not exists (select 1 from gap where gap.market = x.market and gap.symbol = x.symbol)
    ), up as (
      insert into tikr_score.px_daily as t (market, symbol, d, close, volume, amount, source, fetched_at)
      select w.market, w.symbol, w.d, w.close, w.volume, w.amount, 'KIS', now() from w
      on conflict (market, symbol, d) do update
        set close = excluded.close, volume = excluded.volume, amount = excluded.amount, fetched_at = excluded.fetched_at
        where (t.close, t.volume, t.amount) is distinct from (excluded.close, excluded.volume, excluded.amount)
      returning 1
    ), rel as (   -- 봉을 받은 날의 '당일 시세 없음' 보류는 해제(강제 재산출 때 실제 봉을 쓰게)
      delete from tikr_score.px_hold h using w
       where h.market = w.market and h.symbol = w.symbol and h.d = w.d and h.reason = '당일 시세 없음'
      returning 1
    )
    select (select count(*) from up),
           coalesce((select jsonb_agg(jsonb_build_array(chg.market, chg.symbol)) from chg), '[]'::jsonb),
           coalesce((select jsonb_agg(jsonb_build_array(gap.market, gap.symbol)) from gap), '[]'::jsonb)
      into n_px, adj, inc;
  end if;

  -- 지수·환율 [code, d, value] (COMP·KOSPI·KOSDAQ·USDKRW). 충돌 날짜는 수집기가 빼고 보낸다 → 저장값 유지.
  if jsonb_typeof(p->'series') = 'array' then
    with x as (
      select e->>0 as code, (e->>1)::date as d, (e->>2)::float8 as v from jsonb_array_elements(p->'series') e
    ), b as (
      insert into tikr_score.bench_daily as t (code, d, close)
      select x.code, x.d, x.v from x where x.code in ('COMP', 'KOSPI', 'KOSDAQ')
      on conflict (code, d) do update set close = excluded.close where t.close is distinct from excluded.close
      returning 1
    ), f as (
      insert into tikr_score.fx_daily as t (pair, d, rate)
      select 'USDKRW', x.d, x.v from x where x.code = 'USDKRW'
      on conflict (pair, d) do update set rate = excluded.rate where t.rate is distinct from excluded.rate
      returning 1
    )
    select (select count(*) from b) + (select count(*) from f) into n_ser;
  end if;

  if jsonb_typeof(p->'conflicts') = 'array' then
    insert into tikr_score.series_conflict (code, d, vals, resolution)
    select c.code, c.d, c.vals,
           case when exists (select 1 from tikr_score.bench_daily b where b.code = c.code and b.d = c.d)
                  or (c.code = 'USDKRW' and exists (select 1 from tikr_score.fx_daily f where f.d = c.d))
                then '충돌 → 직전 검증값 유지' else '충돌 → 산출 보류' end
      from (select e->>'code' as code, (e->>'d')::date as d,
                   array(select v::float8 from jsonb_array_elements_text(e->'vals') v) as vals
              from jsonb_array_elements(p->'conflicts') e) c;
  end if;

  -- 재무 스냅숏(주 1회). pe_hist는 최신 분기부터.
  if jsonb_typeof(p->'fund') = 'array' then
    insert into tikr_score.fund_snapshot as t (market, symbol, as_of, eps_ttm, rev_growth, debt_ratio_x, roe, equity_positive,
                                              pe_now, pe_hist, market_cap_usd, market_cap_krw, cap_source)
    select e->>'market', e->>'symbol', (e->>'as_of')::date, (e->>'eps_ttm')::float8, (e->>'rev_growth')::float8,
           (e->>'debt_ratio_x')::float8, (e->>'roe')::float8, (e->>'equity_positive')::boolean, (e->>'pe_now')::float8,
           case when jsonb_typeof(e->'pe_hist') = 'array' then
             array(select h.v::float8 from jsonb_array_elements_text(e->'pe_hist') with ordinality h(v, o) order by h.o) end,
           (e->>'market_cap_usd')::float8, (e->>'market_cap_krw')::float8, e->>'cap_source'
      from jsonb_array_elements(p->'fund') e
    on conflict (market, symbol, as_of) do update set
      eps_ttm = excluded.eps_ttm, rev_growth = excluded.rev_growth, debt_ratio_x = excluded.debt_ratio_x, roe = excluded.roe,
      equity_positive = excluded.equity_positive, pe_now = excluded.pe_now, pe_hist = excluded.pe_hist,
      market_cap_usd = excluded.market_cap_usd, market_cap_krw = excluded.market_cap_krw, cap_source = excluded.cap_source;
    get diagnostics n_fund = row_count;
  end if;

  -- 종목 정보 {market, symbol, excd?, currency?} — 준 키만 갱신(currency 키가 있으면 null이어도 확인 시각 기록)
  if jsonb_typeof(p->'symbols') = 'array' then
    insert into tikr_score.symbols as t (market, symbol, excd, currency, currency_at)
    select e->>'market', e->>'symbol', e->>'excd', e->>'currency', case when e ? 'currency' then now() end
      from jsonb_array_elements(p->'symbols') e
    on conflict (market, symbol) do update set
      excd = coalesce(excluded.excd, t.excd),
      currency = case when excluded.currency_at is not null then excluded.currency else t.currency end,
      currency_at = coalesce(excluded.currency_at, t.currency_at);
  end if;

  -- 산출 보류 [market, symbol, d, reason, detail]
  if jsonb_typeof(p->'holds') = 'array' then
    insert into tikr_score.px_hold as t (market, symbol, d, reason, detail)
    select e->>0, e->>1, (e->>2)::date, e->>3, e->4 from jsonb_array_elements(p->'holds') e
    on conflict (market, symbol, d) do update set reason = excluded.reason, detail = excluded.detail, created_at = now();
    get diagnostics n_hold = row_count;
  end if;

  -- 작업 결과 [job, d, market, symbol, done|failed|retry|release, note]
  --   retry = 3분 × 시도 횟수 뒤 다시 대기(시도 횟수 유지) · release = 시간이 모자라 손대지 못하고 반납(시도 횟수 원복)
  if jsonb_typeof(p->'done') = 'array' then
    update tikr_score.collect_task t
       set status = case x.st when 'done' then 'done' when 'failed' then 'failed' else 'pending' end,
           tries = case when x.st = 'release' then greatest(t.tries - 1, 0) else t.tries end,
           retry_at = case when x.st = 'retry' then now() + interval '3 minutes' * greatest(t.tries, 1) end,
           note = left(x.note, 200), leased_at = null, updated_at = now()
      from (select e->>0 as job, (e->>1)::date as d, e->>2 as market, e->>3 as symbol, e->>4 as st, e->>5 as note
              from jsonb_array_elements(p->'done') e) x
     where t.job = x.job and t.d = x.d and t.market = x.market and t.symbol = x.symbol
       and x.st in ('done', 'failed', 'retry', 'release');
    get diagnostics n_done = row_count;
  end if;

  if jsonb_typeof(p->'log') = 'object' then
    insert into tikr_score.collect_log (job, d, summary)
    values (coalesce(p->'log'->>'job', '?'), nullif(p->'log'->>'d', '')::date, coalesce(p->'log'->'summary', '{}'::jsonb));
  end if;

  return jsonb_build_object('px', n_px, 'adjusted', adj, 'incomplete', inc, 'series', n_ser, 'holds', n_hold,
                            'fund', n_fund, 'done', n_done);
end $$;

create or replace function public.tikr_collect_confirm(p_d date, p_max int default 4)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return tikr_score.confirm_days(p_d, p_max);
end $$;

-- 백필 계획: p_items = [[market, symbol], ...] 또는 null(현재 구성원 전체 + 지수·환율). 기존 행은 다시 대기로.
create or replace function public.tikr_collect_plan(p_job text, p_d date, p_items jsonb default null)
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if p_job is distinct from 'backfill' then return tikr_score.plan_tasks(p_job, p_d); end if;
  insert into tikr_score.collect_task as t (job, d, market, symbol, note)
  select 'backfill', p_d, x.market, x.symbol, 'full'
    from (select e->>0 as market, e->>1 as symbol from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) e
          union
          select v.market, v.symbol
            from (values ('US', '#COMP'), ('KR', '#KOSPI'), ('KR', '#KOSDAQ'), ('KR', '#FX')) v(market, symbol)
           where p_items is null
          union
          select u.market, u.symbol from tikr_score.universe u
           where p_items is null and (u.active_to is null or u.active_to > p_d)) x
   where x.market in ('US', 'KR') and x.symbol is not null
  on conflict (job, d, market, symbol) do update
    set status = 'pending', tries = 0, note = 'full', leased_at = null, updated_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

-- 권한: 새 내부 테이블·함수는 PUBLIC 회수, 수집기 공개 함수 4개는 service_role만
revoke all on all tables in schema tikr_score from public;
revoke execute on all functions in schema tikr_score from public;
revoke all on function public.tikr_collect_lease(text, date, int) from public;
revoke all on function public.tikr_collect_ingest(jsonb) from public;
revoke all on function public.tikr_collect_confirm(date, int) from public;
revoke all on function public.tikr_collect_plan(text, date, jsonb) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.tikr_collect_lease(text, date, int) from anon, authenticated;
    revoke all on function public.tikr_collect_ingest(jsonb) from anon, authenticated;
    revoke all on function public.tikr_collect_confirm(date, int) from anon, authenticated;
    revoke all on function public.tikr_collect_plan(text, date, jsonb) from anon, authenticated;
    grant execute on function public.tikr_collect_lease(text, date, int) to service_role;
    grant execute on function public.tikr_collect_ingest(jsonb) to service_role;
    grant execute on function public.tikr_collect_confirm(date, int) to service_role;
    grant execute on function public.tikr_collect_plan(text, date, jsonb) to service_role;
  end if;
end $$;
