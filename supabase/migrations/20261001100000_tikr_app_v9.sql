-- 티커 앱 v9.2 화면용 공개 함수 — 볼트 「앱_v9_구현」(2026-10-01).
-- 엔진(20260930000000)·수집기(20261001000000) 다음에 적용. 기존 테이블·함수는 바꾸지 않고 더하기만 한다.
-- 원칙
--   · 앱(anon)은 public.tikr_*_json 읽기 함수와 쓰기 함수 2개(피드백·보유 코드 등록)만 부른다. 결과 JSON만(수 KB).
--   · 판정 문구(고점권·금리 하락 등)는 앱이 고정 규칙으로 만든다 — DB는 숫자(52주 위치 0~1·수익률·배수)만 돌려준다.
--   · 보유 수량·평단은 저장하지 않는다(앱이 기기에 저장). 보유 종목 코드만 유니버스에 등록(테마 없음, 최대 40).
--   · tikr-extra(service_role)가 VIX·종목 이름을 채운다: public.tikr_extra_state / tikr_extra_ingest.
--   · 결측은 결측으로(0 변환 금지). 비교는 isnum()으로만.

-- ── 저장 테이블 ─────────────────────────────────────

-- 종목 표시 이름(한글). 출처: tikr-extra(KIS 상품 정보) · 앱 보유 등록(검색 결과 이름) · 수동
create table tikr_score.names (
  market     text not null check (market in ('US', 'KR')),
  symbol     text not null,
  name       text not null check (length(name) between 1 and 60),
  source     text not null default 'kis' check (source in ('kis', 'app', 'manual')),
  updated_at timestamptz not null default now(),
  primary key (market, symbol)
);

-- 거시 지표 일별(발표 기준 날짜). VIX = FRED VIXCLS 종가.
create table tikr_score.macro_daily (
  code  text not null check (code in ('VIX')),
  d     date not null,
  value double precision not null check (value > 0 and value < 'Infinity'::float8),
  primary key (code, d)
);

-- 앱 피드백(앱 키로는 쓰기만). 다음 세션에서 읽고 read_at 기록.
create table tikr_score.feedback (
  id         bigserial primary key,
  created_at timestamptz not null default now(),
  screen     text,
  body       text not null check (length(body) between 1 and 1000),
  app_ver    text,
  read_at    timestamptz
);

alter table tikr_score.names       enable row level security;
alter table tikr_score.macro_daily enable row level security;
-- 이름을 KIS에서 못 찾은 종목: 7일 동안 다시 묻지 않는다(못 찾는 종목이 할 일 목록 앞을 막지 않게)
create table tikr_score.name_miss (
  market   text not null,
  symbol   text not null,
  tried_at timestamptz not null default now(),
  primary key (market, symbol)
);

alter table tikr_score.feedback    enable row level security;
alter table tikr_score.name_miss   enable row level security;

-- ── 일별 시리즈(홈 화면) ────────────────────────────
-- 금·비트코인·국채는 기존 시세 기록(public.quote_history)의 한국 날짜별 마지막 값. 3일 지난 기록은 하루 1행으로 줄어 있다.
-- 2026-07~09 서비스 정지 구간은 빈 날로 남는다(52주 범위는 있는 관측만으로).
create or replace view tikr_score.quote_daily as
  select distinct on (h.symbol, (h.fetched_at at time zone 'Asia/Seoul')::date)
         h.symbol, (h.fetched_at at time zone 'Asia/Seoul')::date as d, h.price::float8 as v
  from public.quote_history h
  where h.symbol in ('XAUUSD', 'BTC_KRW', 'US_BOND_10Y', 'KR_BOND_3Y') and h.price > 0
  order by h.symbol, (h.fetched_at at time zone 'Asia/Seoul')::date, h.fetched_at desc;

create or replace view tikr_score.daily_series as
  select b.code, b.d, b.close as v from tikr_score.bench_daily b
  union all
  select 'USDKRW', f.d, f.rate from tikr_score.fx_daily f
  union all
  select m.code, m.d, m.value from tikr_score.macro_daily m
  union all
  select q.symbol, q.d, q.v from tikr_score.quote_daily q
  union all   -- 비트코인 달러 환산 = 원화 가격 ÷ 그날(as-of) 원/달러
  select 'BTC_USD', q.d, q.v / fx.rate
  from tikr_score.quote_daily q
  cross join lateral (select f.rate from tikr_score.fx_daily f where f.d <= q.d order by f.d desc limit 1) fx
  where q.symbol = 'BTC_KRW';

-- ── 공통 계산 ───────────────────────────────────────

-- 52주 위치 = (값 − 최저) / (최고 − 최저), 0~1로 자름. 범위 0·관측 20개 미만이면 결측.
create or replace function tikr_score.pos52(p_v double precision, p_lo double precision, p_hi double precision, p_n bigint)
returns double precision language sql immutable as $$
  select case when tikr_score.isnum(p_v) and tikr_score.isnum(p_lo) and tikr_score.isnum(p_hi)
               and p_hi > p_lo and coalesce(p_n, 0) >= 20
              then tikr_score.clamp01((p_v - p_lo) / (p_hi - p_lo)) end
$$;

-- 시리즈 요약(날짜 오름차순 배열 입력): 마지막·직전 값, 마지막 날짜 기준 52주(365일) 최저·최고·위치,
-- 1M·3M·1Y 전(30·91·365일 전 as-of) 값·날짜·그 값의 현재 52주 범위 내 위치,
-- 마지막 일간 변화율과 그 전 60개 일간 변화율 절댓값 평균(이례 움직임 판정용, 40개 미만이면 결측).
create or replace function tikr_score.stat_arr(p_d date[], p_v double precision[])
returns jsonb language sql immutable as $$
  with s as (
    select t.d, t.v from unnest(p_d, p_v) as t(d, v)
    where t.d is not null and tikr_score.isnum(t.v)
  ), l as (
    select s.d, s.v from s order by s.d desc limit 1
  ), w as (
    select min(s.v) as lo, max(s.v) as hi, count(*) as n from s cross join l where s.d > l.d - 365 and s.d <= l.d
  ), pv as (
    select s.d, s.v from s cross join l where s.d < l.d order by s.d desc limit 1
  ), ago as (
    select k.k, a.d, a.v
    from l cross join (values ('1M', 30), ('3M', 91), ('1Y', 365)) as k(k, days)
    left join lateral (select s.d, s.v from s where s.d <= l.d - k.days order by s.d desc limit 1) a on true
  ), r as (
    select s.d, case when lag(s.v) over (order by s.d) > 0 then s.v / lag(s.v) over (order by s.d) - 1 end as r from s
  ), rb as (
    select avg(abs(x.r)) as a, count(*) as n
    from (select r.r from r where r.r is not null order by r.d desc offset 1 limit 60) x
  )
  select jsonb_build_object(
    'd', l.d, 'v', l.v, 'prev_d', pv.d, 'prev', pv.v,
    'chg', case when tikr_score.isnum(pv.v) and pv.v > 0 then l.v / pv.v - 1 end,
    'lo', w.lo, 'hi', w.hi, 'n', w.n,
    'pos', tikr_score.pos52(l.v, w.lo, w.hi, w.n),
    'ago', (select jsonb_object_agg(ago.k, jsonb_build_object(
              'd', ago.d, 'v', ago.v,
              'chg', case when tikr_score.isnum(ago.v) and ago.v > 0 then l.v / ago.v - 1 end,
              'pos', tikr_score.pos52(ago.v, w.lo, w.hi, w.n)))
            from ago),
    'a60', case when rb.n >= 40 then rb.a end
  )
  from l cross join w cross join rb left join pv on true
$$;

create or replace function tikr_score.series_stat(p_code text)
returns jsonb language sql stable as $$
  select case when count(*) = 0 then null
              else tikr_score.stat_arr(array_agg(s.d order by s.d), array_agg(s.v order by s.d)) end
  from tikr_score.daily_series s where s.code = p_code
$$;

-- 종목 일봉 요약(최근 400달력일이면 52주·1Y 전·60일 변동 모두 덮음)
create or replace function tikr_score.px_stat(p_market text, p_symbol text)
returns jsonb language sql stable as $$
  select case when count(*) = 0 then null
              else tikr_score.stat_arr(array_agg(p.d order by p.d), array_agg(p.close order by p.d)) end
  from tikr_score.px_daily p
  where p.market = p_market and p.symbol = p_symbol
    and p.d > (select max(x.d) from tikr_score.px_daily x where x.market = p_market and x.symbol = p_symbol) - 400
$$;

-- 모멘텀 순위(최신 평가일, 표시 점수 기준). 순위 모집단 = 그날 표시 점수가 있는 종목.
create or replace function tikr_score.mom_rank(p_market text)
returns table (symbol text, d date, display double precision, display_status text, raw double precision, status text,
               surge boolean, raw_jump boolean, rk bigint, n bigint,
               r1 double precision, r1x double precision, r3x double precision, y double precision, v double precision,
               p3x double precision, p1x double precision, py double precision, pv_eff double precision)
language sql stable as $$
  with d as (select max(m.d) as d from tikr_score.momentum_daily m where m.market = p_market)
  select mv.symbol, mv.d, mv.display, mv.display_status, mv.raw, mv.status, mv.surge, mv.raw_jump,
         case when tikr_score.isnum(mv.display) then rank() over (partition by tikr_score.isnum(mv.display) order by mv.display desc) end,
         count(*) filter (where tikr_score.isnum(mv.display)) over (),
         mv.r1, mv.r1x, mv.r3x, mv.y, mv.v, mv.p3x, mv.p1x, mv.py, mv.pv_eff
  from tikr_score.momentum_view mv cross join d
  where mv.market = p_market and mv.d = d.d
$$;

-- 발견 목록(엔진 momentum_list 그대로 + 이름·구성 요소). 핵심 근거 선택은 앱 규칙(가중 점수 최대 항목).
create or replace function tikr_score.top_list(p_market text, p_limit int)
returns jsonb language sql stable as $$
  with d as (select max(m.d) as d from tikr_score.momentum_daily m where m.market = p_market)
  select coalesce(jsonb_agg(jsonb_build_object(
           'symbol', l.symbol, 'name', n.name, 'theme', l.theme, 'display', l.display, 'display_status', l.display_status,
           'status', l.status, 'surge', l.surge, 'raw_jump', l.raw_jump,
           'r1x', md.r1x, 'r3x', md.r3x, 'y', md.y, 'v', md.v,
           'p3x', md.p3x, 'p1x', md.p1x, 'py', md.py, 'pv_eff', md.pv_eff)
         order by l.display desc, l.symbol collate "C"), '[]'::jsonb)
  from d
  cross join lateral tikr_score.momentum_list(p_market, d.d, p_limit) l
  left join tikr_score.momentum_daily md on md.market = p_market and md.symbol = l.symbol and md.d = d.d
  left join tikr_score.names n on n.market = p_market and n.symbol = l.symbol
$$;

-- 테마 통계(현재 구성원, 테마 있는 종목만). 기준일 D = 시장 대표 지수(미 COMP·한 KOSPI) 최신 날짜.
--   거래대금 비중(t) = 테마 구성원 20거래일 평균 거래대금 합 ÷ 전체 구성원 합(각 종목 t 이전 20봉, 16봉 미만 종목은 빠짐)
--   변화 = 비중(D) − 비중(D − 30·91·365일)  (%p는 앱이 ×100)
--   테마 수익률 = 구성원 기간 수익률 단순 평균(as-of 종가), 상승 = 기간 수익률 > 0 종목 수
create or replace function tikr_score.theme_stats(p_market text, p_theme text default null)
returns jsonb language sql stable as $$
  with dd as (
    select max(b.d) as d from tikr_score.bench_daily b where b.code = case when p_market = 'US' then 'COMP' else 'KOSPI' end
  ), u as (
    select distinct on (x.symbol) x.symbol, x.theme from tikr_score.universe x
    where x.market = p_market and x.active_to is null
    order by x.symbol, x.active_from desc
  ), k as (
    select k.k, dd.d - k.days as t from dd cross join (values ('0', 0), ('1M', 30), ('3M', 91), ('1Y', 365)) as k(k, days)
  ), a as (   -- 종목 × 시점: 20봉 평균 거래대금, 그 시점 as-of 종가
    select k.k, u.symbol, u.theme, am.a20, cl.c
    from k cross join u
    left join lateral (
      select case when count(z.amount) >= 16 then avg(z.amount) end as a20   -- 최근 20봉 중 거래대금 16개 이상
      from (select p.amount from tikr_score.px_daily p
            where p.market = p_market and p.symbol = u.symbol and p.d <= k.t
            order by p.d desc limit 20) z
    ) am on true
    left join lateral (
      select p.close as c from tikr_score.px_daily p
      where p.market = p_market and p.symbol = u.symbol and p.d <= k.t
      order by p.d desc limit 1
    ) cl on true
  ), tot as (
    select a.k, sum(a.a20) as s from a where tikr_score.isnum(a.a20) group by a.k
  ), sh as (   -- 테마 × 시점 비중
    select a.theme, a.k, sum(a.a20) / nullif(tot.s, 0) as share
    from a join tot on tot.k = a.k
    where a.theme is not null and tikr_score.isnum(a.a20)
    group by a.theme, a.k, tot.s
  ), rt as (   -- 테마 × 기간 수익률
    select a.theme, a.k,
           avg(n.c / a.c - 1) as ret,
           count(*) filter (where n.c / a.c - 1 > 0) as up,
           count(*) as n_ret
    from a join a n on n.k = '0' and n.symbol = a.symbol
    where a.k <> '0' and a.theme is not null and a.c > 0 and n.c > 0
    group by a.theme, a.k
  ), th as (
    select u.theme, count(*) as n from u where u.theme is not null and (p_theme is null or u.theme = p_theme) group by u.theme
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'theme', th.theme, 'n', th.n, 'd', dd.d,
      'share', (select sh.share from sh where sh.theme = th.theme and sh.k = '0'),
      'chg', (select jsonb_object_agg(x.k, x.v) from (
                select p.k, now_.share - p.share as v from sh now_ join sh p on p.theme = now_.theme and p.k <> '0'
                where now_.theme = th.theme and now_.k = '0') x(k, v)),
      'ret', (select jsonb_object_agg(rt.k, rt.ret) from rt where rt.theme = th.theme),
      'up',  (select jsonb_object_agg(rt.k, rt.up) from rt where rt.theme = th.theme),
      'n_ret', (select jsonb_object_agg(rt.k, rt.n_ret) from rt where rt.theme = th.theme))
    order by th.theme), '[]'::jsonb)
  from th cross join dd
$$;

-- ── 앱용 읽기 함수(공개, anon) ──────────────────────

create or replace function public.tikr_home_json(p_market text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with m as (select upper(btrim(coalesce(p_market, ''))) as m)
  select case when m.m not in ('US', 'KR') then jsonb_build_object('error', '시장은 US·KR')
  else jsonb_build_object(
    'market', m.m,
    'series', (select jsonb_object_agg(c.code, tikr_score.series_stat(c.code))
               from unnest(case when m.m = 'US'
                                then array['COMP', 'USDKRW', 'US_BOND_10Y', 'VIX', 'XAUUSD', 'BTC_USD']
                                else array['KOSPI', 'KOSDAQ', 'USDKRW', 'KR_BOND_3Y', 'XAUUSD'] end) as c(code)),
    'top', tikr_score.top_list(m.m, 1) -> 0,
    'mom_d', (select max(x.d) from tikr_score.momentum_daily x where x.market = m.m)
  ) end
  from m
$$;

create or replace function public.tikr_discover_json(p_market text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with m as (select upper(btrim(coalesce(p_market, ''))) as m)
  select case when m.m not in ('US', 'KR') then jsonb_build_object('error', '시장은 US·KR')
  else jsonb_build_object(
    'market', m.m,
    'mom_d', (select max(x.d) from tikr_score.momentum_daily x where x.market = m.m),
    'list', tikr_score.top_list(m.m, 20),
    'themes', tikr_score.theme_stats(m.m, null),
    'bench', tikr_score.series_stat(case when m.m = 'US' then 'COMP' else 'KOSPI' end)
  ) end
  from m
$$;

create or replace function public.tikr_theme_json(p_market text, p_theme text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with m as (select upper(btrim(coalesce(p_market, ''))) as m, btrim(coalesce(p_theme, '')) as t)
  select case when m.m not in ('US', 'KR') or m.t = '' then jsonb_build_object('error', '시장·테마 필요')
  else jsonb_build_object(
    'market', m.m, 'theme', m.t,
    'stat', tikr_score.theme_stats(m.m, m.t) -> 0,
    'bench', tikr_score.series_stat(case when m.m = 'US' then 'COMP' else 'KOSPI' end),
    'members', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'symbol', u.symbol, 'name', n.name,
               'ret', (tikr_score.px_stat(m.m, u.symbol) -> 'ago'),
               'display', r.display, 'status', r.status, 'surge', r.surge, 'rk', r.rk, 'n', r.n)
             order by (case when tikr_score.isnum(r.display) then r.display end) desc nulls last, u.symbol collate "C"), '[]'::jsonb)
      from (select distinct on (x.symbol) x.symbol from tikr_score.universe x
            where x.market = m.m and x.theme = m.t and x.active_to is null
            order by x.symbol, x.active_from desc) u
      left join tikr_score.names n on n.market = m.m and n.symbol = u.symbol
      left join tikr_score.mom_rank(m.m) r on r.symbol = u.symbol)
  ) end
  from m
$$;

create or replace function public.tikr_stock_json(p_market text, p_symbol text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with m as (select upper(btrim(coalesce(p_market, ''))) as m, upper(btrim(coalesce(p_symbol, ''))) as s),
  u as (
    select x.theme, x.bench, x.kr_financial, x.active_to is null as current_member
    from tikr_score.universe x cross join m
    where x.market = m.m and x.symbol = m.s
    order by x.active_from desc limit 1
  ),
  f as (
    select x.* from tikr_score.fund_snapshot x cross join m
    where x.market = m.m and x.symbol = m.s order by x.as_of desc limit 1
  ),
  vh as (   -- 밸류에이션 5년 위치(엔진 valuation_label과 같은 이력 규칙: 최신 20분기 중 유효값, 12개 이상)
    select count(*) filter (where h.x <= f.pe_now) as le, count(*) as cnt
    from f cross join lateral unnest(f.pe_hist[1:20]) as h(x)
    where tikr_score.isnum(h.x) and h.x > 0
  )
  select case when m.m not in ('US', 'KR') or m.s = '' or length(m.s) > 12 then jsonb_build_object('error', '시장·종목 코드 필요')
  else jsonb_build_object(
    'market', m.m, 'symbol', m.s,
    'name', (select n.name from tikr_score.names n where n.market = m.m and n.symbol = m.s),
    'theme', (select u.theme from u), 'bench', (select u.bench from u),
    'tracked', coalesce((select u.current_member from u), false),
    'px', tikr_score.px_stat(m.m, m.s),
    'fx', tikr_score.series_stat('USDKRW') - 'ago',
    'mom', (select to_jsonb(r) - 'symbol' from tikr_score.mom_rank(m.m) r where r.symbol = m.s),
    'fund', (select jsonb_build_object(
               'as_of', f.as_of, 'eps', f.eps_ttm, 'rev', f.rev_growth, 'debt_x', f.debt_ratio_x, 'roe', f.roe,
               'equity_positive', f.equity_positive, 'cap_usd', f.market_cap_usd, 'cap_krw', f.market_cap_krw,
               'label', tikr_score.fund_label(f.eps_ttm, f.rev_growth, f.debt_ratio_x, f.roe, f.equity_positive,
                                              coalesce((select u.kr_financial from u), false)))
             from f),
    'val', (select jsonb_build_object(
              'pe', f.pe_now, 'label', tikr_score.valuation_label(f.eps_ttm, f.pe_now, f.pe_hist),
              'pos5y', case when vh.cnt >= 12 and tikr_score.isnum(f.pe_now) and f.pe_now > 0 then vh.le::float8 / vh.cnt end,
              'n_hist', vh.cnt)
            from f cross join vh)
  ) end
  from m
$$;

-- 내 종목: 보유·관심 코드 목록(수량 없음, 최대 60) → 종목별 일봉 요약·모멘텀. 원화 평가·비중·손익은 앱이 계산.
create or replace function public.tikr_holdings_json(p_items jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
  with it as (
    select distinct upper(e->>'market') as market, upper(btrim(e->>'symbol')) as symbol
    from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' and jsonb_array_length(p_items) <= 60
                                   then p_items else '[]'::jsonb end) as e
    where jsonb_typeof(e) = 'object' and upper(e->>'market') in ('US', 'KR')
      and jsonb_typeof(e->'symbol') = 'string' and length(btrim(e->>'symbol')) between 1 and 12
  ), mk as (select distinct it.market from it
  ), mr as (   -- 모멘텀 순위는 시장별 한 번만 계산
    select mk.market, r.* from mk cross join lateral tikr_score.mom_rank(mk.market) r
  )
  select case when jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) > 60
              then jsonb_build_object('error', '종목 목록은 60개 이하 배열이어야 해요')
  else jsonb_build_object(
    'fx', tikr_score.series_stat('USDKRW') - 'ago',
    'mom_d', (select jsonb_object_agg(mk.market, (select max(x.d) from tikr_score.momentum_daily x where x.market = mk.market)) from mk),
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'market', it.market, 'symbol', it.symbol,
               'name', (select n.name from tikr_score.names n where n.market = it.market and n.symbol = it.symbol),
               'theme', (select x.theme from tikr_score.universe x where x.market = it.market and x.symbol = it.symbol
                          order by x.active_from desc limit 1),
               'tracked', exists (select 1 from tikr_score.universe x where x.market = it.market and x.symbol = it.symbol and x.active_to is null),
               'px', tikr_score.px_stat(it.market, it.symbol),
               'mom', (select jsonb_build_object('d', r.d, 'display', r.display, 'status', r.status, 'surge', r.surge,
                                                  'rk', r.rk, 'n', r.n)
                       from mr r where r.market = it.market and r.symbol = it.symbol))
             order by it.market desc, it.symbol), '[]'::jsonb)
      from it)
  ) end
$$;

-- 종목 검색(이름·코드): 유니버스 구성원 + 이름 있는 종목. 보유 입력용.
create or replace function public.tikr_search_json(p_q text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with q as (select btrim(coalesce(p_q, '')) as q),
  c as (
    select distinct on (x.market, x.symbol) x.market, x.symbol, x.bench, x.theme
    from tikr_score.universe x where x.active_to is null
    order by x.market, x.symbol, x.active_from desc
  ), cand as (
    select coalesce(c.market, n.market) as market, coalesce(c.symbol, n.symbol) as symbol, n.name, c.bench, c.theme
    from c full join tikr_score.names n on n.market = c.market and n.symbol = c.symbol
  )
  select case when length(q.q) not between 1 and 30 then '[]'::jsonb
  else coalesce((
    select jsonb_agg(jsonb_build_object('market', z.market, 'symbol', z.symbol, 'name', z.name, 'bench', z.bench, 'theme', z.theme)
                     order by z.exact desc, z.symbol collate "C")
    from (
      select cand.*, coalesce(upper(cand.symbol) = upper(q.q) or cand.name = q.q, false) as exact
      from cand
      where upper(cand.symbol) like upper(replace(replace(replace(q.q, '\', '\\'), '%', '\%'), '_', '\_')) || '%'
         or cand.name ilike '%' || replace(replace(replace(q.q, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      order by exact desc, cand.symbol collate "C"
      limit 20) z), '[]'::jsonb) end
  from q
$$;

-- ── 앱용 쓰기 함수(공개, anon) ──────────────────────

-- 피드백: 1~1000자, 하루 전체 100건까지(앱 키는 누구나 가질 수 있어 폭주 방지).
create or replace function public.tikr_feedback_add(p_screen text, p_body text, p_ver text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare b text := btrim(coalesce(p_body, ''));
begin
  if length(b) = 0 or length(b) > 1000 then
    return jsonb_build_object('ok', false, 'error', '1~1000자로 적어 주세요');
  end if;
  perform pg_advisory_xact_lock(hashtext('tikr_feedback'));
  if (select count(*) from tikr_score.feedback where created_at > now() - interval '1 day') >= 100 then
    return jsonb_build_object('ok', false, 'error', '오늘 보낼 수 있는 한도를 넘었어요');
  end if;
  insert into tikr_score.feedback (screen, body, app_ver) values (left(p_screen, 40), b, left(p_ver, 20));
  return jsonb_build_object('ok', true);
end $$;

-- 보유 종목 코드 등록: 유니버스에 테마 없이 편입(시총 조건 무관 추적). 앱 등록분은 현재 40개까지.
--   편입일 = 오늘 − 7일: 수집기가 직전 평가일 작업에도 넣도록(이미 확정된 날은 엔진이 다시 계산하지 않는다).
--   이미 현재 구성원이면 이름만 보충. 수량·평단은 받지 않는다. 이름은 편입이 확정된(또는 이미 구성원인) 종목만 저장.
--   예전에 제외된 구간이 있으면 새 편입일은 그 제외일 이후(구간 겹침·기본키 충돌 방지).
create or replace function public.tikr_track_symbol(p_market text, p_symbol text, p_name text default null, p_bench text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  m text := upper(btrim(coalesce(p_market, '')));
  s text := upper(btrim(coalesce(p_symbol, '')));
  nm text := nullif(btrim(coalesce(p_name, '')), '');
  b text;
  n int;
  af date;
begin
  if m not in ('US', 'KR') then
    return jsonb_build_object('ok', false, 'error', '시장은 US·KR');
  end if;
  if (m = 'US' and s !~ '^[A-Z][A-Z0-9]{0,5}([./][A-Z])?$') or (m = 'KR' and s !~ '^[0-9][0-9A-Z]{5}$') then
    return jsonb_build_object('ok', false, 'error', '종목 코드 형식이 맞지 않아요');
  end if;
  if nm is not null and length(nm) > 60 then nm := left(nm, 60); end if;
  perform pg_advisory_xact_lock(hashtext('tikr_track'));
  if exists (select 1 from tikr_score.universe x where x.market = m and x.symbol = s and x.active_to is null) then
    if nm is not null then
      insert into tikr_score.names (market, symbol, name, source) values (m, s, nm, 'app')
      on conflict (market, symbol) do nothing;
    end if;
    return jsonb_build_object('ok', true, 'new', false);
  end if;
  select count(*) into n from tikr_score.universe x
  where x.active_to is null
    and exists (select 1 from tikr_score.universe_log l
                where l.market = x.market and l.symbol = x.symbol and l.reason = '앱 보유 등록');
  if n >= 40 then
    return jsonb_build_object('ok', false, 'error', '추적 종목 한도(40)를 넘었어요');
  end if;
  b := case when m = 'US' then 'COMP'
            when upper(coalesce(p_bench, '')) in ('KOSPI', 'KOSDAQ') then upper(p_bench)
            else 'KOSPI' end;
  select greatest(current_date - 7, coalesce(max(x.active_to), current_date - 7)) into af
  from tikr_score.universe x where x.market = m and x.symbol = s;
  insert into tikr_score.universe (market, symbol, bench, theme, kr_financial, active_from)
  values (m, s, b, null, false, af)
  on conflict do nothing;
  get diagnostics n = row_count;
  if n = 0 then
    return jsonb_build_object('ok', false, 'error', '등록하지 못했어요. 잠시 뒤 다시 시도해 주세요');
  end if;
  insert into tikr_score.universe_log (market, symbol, action, reason, effective)
  values (m, s, '편입', '앱 보유 등록', af);
  if nm is not null then
    insert into tikr_score.names (market, symbol, name, source) values (m, s, nm, 'app')
    on conflict (market, symbol) do nothing;
  end if;
  return jsonb_build_object('ok', true, 'new', true);
end $$;

-- ── tikr-extra(service_role) ────────────────────────

-- 할 일 조회: VIX 마지막 날짜, 이름 없는 현재 구성원(미국은 KIS 거래소 코드 포함, 최대 60).
--   p_after('시장:코드')보다 뒤만 — 이름을 못 찾는 종목이 앞에 쌓여도 다음 페이지로 넘어가게.
create or replace function public.tikr_extra_state(p_after text default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'vix_last', (select max(x.d) from tikr_score.macro_daily x where x.code = 'VIX'),
    'names_missing', coalesce((
      select jsonb_agg(jsonb_build_object('market', z.market, 'symbol', z.symbol, 'excd', z.excd, 'key', z.k)
                       order by z.k collate "C")
      from (select distinct u.market, u.symbol, sy.excd, (u.market || ':' || u.symbol) collate "C" as k
            from tikr_score.universe u
            left join tikr_score.symbols sy on sy.market = u.market and sy.symbol = u.symbol
            where u.active_to is null
              and not exists (select 1 from tikr_score.names n where n.market = u.market and n.symbol = u.symbol)
              and not exists (select 1 from tikr_score.name_miss x where x.market = u.market and x.symbol = u.symbol
                                and x.tried_at > now() - interval '7 days')
              and (p_after is null or (u.market || ':' || u.symbol) collate "C" > p_after collate "C")
            order by k
            limit 60) z), '[]'::jsonb))
$$;

-- 넣기: {"macro":[["VIX","2026-09-30",16.2],...], "names":[["US","MU","마이크론"],...], "miss":[["US","XYZ"],...]}.
--   이상값은 건너뛰고 수만 돌려준다. miss = KIS에서 이름을 못 찾은 종목(7일 뒤 다시 시도).
create or replace function public.tikr_extra_ingest(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare n_macro int := 0; n_names int := 0; n_miss int := 0;
begin
  insert into tikr_score.macro_daily (code, d, value)
  select e->>0, (e->>1)::date, (e->>2)::float8
  from jsonb_array_elements(coalesce(p->'macro', '[]'::jsonb)) as e
  where jsonb_typeof(e) = 'array' and e->>0 = 'VIX'
    and (e->>1) ~ '^\d{4}-\d{2}-\d{2}$' and (e->>2) ~ '^[0-9]+(\.[0-9]+)?$' and (e->>2)::float8 > 0
  on conflict (code, d) do update set value = excluded.value;
  get diagnostics n_macro = row_count;

  insert into tikr_score.names (market, symbol, name, source)
  select e->>0, e->>1, left(btrim(e->>2), 60), 'kis'
  from jsonb_array_elements(coalesce(p->'names', '[]'::jsonb)) as e
  where jsonb_typeof(e) = 'array' and e->>0 in ('US', 'KR') and length(coalesce(e->>1, '')) between 1 and 12
    and length(btrim(coalesce(e->>2, ''))) between 1 and 60
  on conflict (market, symbol) do update set name = excluded.name, source = 'kis', updated_at = now()
    where tikr_score.names.source <> 'manual';
  get diagnostics n_names = row_count;

  insert into tikr_score.name_miss (market, symbol, tried_at)
  select e->>0, e->>1, now()
  from jsonb_array_elements(coalesce(p->'miss', '[]'::jsonb)) as e
  where jsonb_typeof(e) = 'array' and e->>0 in ('US', 'KR') and length(coalesce(e->>1, '')) between 1 and 12
  on conflict (market, symbol) do update set tried_at = now();
  get diagnostics n_miss = row_count;

  return jsonb_build_object('macro', n_macro, 'names', n_names, 'miss', n_miss);
end $$;

-- ── 권한 ────────────────────────────────────────────
-- 새 내부 테이블·함수는 PUBLIC 회수. 앱용 8개는 anon·authenticated 실행, tikr-extra 2개는 service_role만.
revoke all on all tables in schema tikr_score from public;
revoke execute on all functions in schema tikr_score from public;
revoke all on function public.tikr_home_json(text) from public;
revoke all on function public.tikr_discover_json(text) from public;
revoke all on function public.tikr_theme_json(text, text) from public;
revoke all on function public.tikr_stock_json(text, text) from public;
revoke all on function public.tikr_holdings_json(jsonb) from public;
revoke all on function public.tikr_search_json(text) from public;
revoke all on function public.tikr_feedback_add(text, text, text) from public;
revoke all on function public.tikr_track_symbol(text, text, text, text) from public;
revoke all on function public.tikr_extra_state(text) from public;
revoke all on function public.tikr_extra_ingest(jsonb) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function public.tikr_home_json(text) to anon, authenticated;
    grant execute on function public.tikr_discover_json(text) to anon, authenticated;
    grant execute on function public.tikr_theme_json(text, text) to anon, authenticated;
    grant execute on function public.tikr_stock_json(text, text) to anon, authenticated;
    grant execute on function public.tikr_holdings_json(jsonb) to anon, authenticated;
    grant execute on function public.tikr_search_json(text) to anon, authenticated;
    grant execute on function public.tikr_feedback_add(text, text, text) to anon, authenticated;
    grant execute on function public.tikr_track_symbol(text, text, text, text) to anon, authenticated;
    revoke all on function public.tikr_extra_state(text) from anon, authenticated;
    revoke all on function public.tikr_extra_ingest(jsonb) from anon, authenticated;
    grant execute on function public.tikr_extra_state(text) to service_role;
    grant execute on function public.tikr_extra_ingest(jsonb) to service_role;
  end if;
end $$;
