-- 티커 점수 엔진 — 볼트 「점수기준서_v1」 v1.4 구현.
-- 정답지(파이썬 참조 구현): 볼트 Projects/주식분석-앱/점수기준_참조구현/ref_v13.py·ref_series_v13.py
--   → 같은 입력이면 결과가 같아야 한다(실데이터 전수 대조로 확인).
-- 설계 원칙
--   · 계산은 DB 안에서(서버 함수가 1년 일봉을 읽어 가면 월 수백 MB egress) → 앱은 결과 JSON만 받는다.
--   · 보유 수량은 저장하지 않는다. 앱이 RPC 인자로 넘기고 계산에만 쓴다.
--   · 결측은 결측으로(0점·만점 변환 금지). GREATEST/LEAST는 NULL을 무시하므로 clamp01()만 쓴다.
--   · float8의 NaN은 모든 수보다 크게 비교된다 → 저장 제약과 비교 모두 유한값만 인정한다.
--   · 임계값 비교는 1e-9 허용(부동소수점 경계 흔들림 방지).
--   · 운영 적용은 수집기(확정 일봉·지수·환율·재무 적재) 완성 후. 그 전까지 브랜치에서만 관리.
--   · 처음 적용 전용: 테이블은 엄격 생성(if not exists 아님) — 초안 잔재가 있으면 조용히 옛 구조를 쓰지 않고 실패한다
--     (운영 데이터가 없으므로 drop schema tikr_score cascade 후 적용).

create schema if not exists tikr_score;

-- ── 공통 함수 ───────────────────────────────────────

create or replace function tikr_score.isnum(x double precision)
returns boolean language sql immutable as $$
  select x is not null and x <> 'NaN'::float8 and x <> 'Infinity'::float8 and x <> '-Infinity'::float8
$$;

-- 결측이면 결측. (GREATEST/LEAST 단독 사용 금지 — NULL을 무시해 결측이 만점이 된다)
create or replace function tikr_score.clamp01(x double precision)
returns double precision language sql immutable as $$
  select case when tikr_score.isnum(x) then greatest(0::float8, least(1::float8, x)) end
$$;

-- ── 저장 테이블 ─────────────────────────────────────
-- 유한값 제약: x > 0 and x < 'Infinity' 는 NaN(무한대보다 큼)·무한대를 함께 막는다.

-- 확정 일봉(수정주가). 수집기는 장 마감(+30분) 전 조회분의 오늘 봉을 넣지 않는다.
create table tikr_score.px_daily (
  market     text not null check (market in ('US', 'KR')),
  symbol     text not null,
  d          date not null,
  close      double precision not null check (close > 0 and close < 'Infinity'::float8),
  volume     double precision check (volume is null or (volume >= 0 and volume < 'Infinity'::float8)),
  amount     double precision check (amount is null or (amount >= 0 and amount < 'Infinity'::float8)),  -- 거래대금(미 USD, 한 KRW)
  source     text not null default 'KIS',
  fetched_at timestamptz not null default now(),
  primary key (market, symbol, d)
);

create table tikr_score.bench_daily (
  code  text not null check (code in ('COMP', 'KOSPI', 'KOSDAQ')),
  d     date not null,
  close double precision not null check (close > 0 and close < 'Infinity'::float8),
  primary key (code, d)
);

create table tikr_score.fx_daily (
  pair text not null default 'USDKRW' check (pair = 'USDKRW'),
  d    date not null,
  rate double precision not null check (rate > 0 and rate < 'Infinity'::float8),
  primary key (pair, d)
);

-- 산출 보류(수집기가 기록). 종목의 최신 봉 날짜 ≤ d ≤ 평가일이면 거래정지처럼 순위에서 빼고 원점수 결측 + 사유 표시.
--   가격 불일치 = 확정 산출 직전 2출처 대조 오차 0.5% 초과(d = 그 봉 날짜)
--   당일 시세 없음 = 시장은 열렸는데 그 종목 봉을 받지 못함(d = 그 거래일)
create table tikr_score.px_hold (
  market     text not null check (market in ('US', 'KR')),
  symbol     text not null,
  d          date not null,
  reason     text not null check (reason in ('가격 불일치', '당일 시세 없음')),
  detail     jsonb,
  created_at timestamptz not null default now(),
  primary key (market, symbol, d)
);

-- 유니버스: 편입·제외는 매월 첫 거래일에만(순위 모집단 안정). 평가일 당시 구성원 = active_from ≤ d < active_to.
create table tikr_score.universe (
  market       text not null check (market in ('US', 'KR')),
  symbol       text not null,
  bench        text not null check (bench in ('COMP', 'KOSPI', 'KOSDAQ')),
  theme        text,
  kr_financial boolean not null default false,
  active_from  date not null,
  active_to    date,                     -- 제외일(그날부터 제외), NULL이면 현재 편입
  primary key (market, symbol, active_from),   -- 재편입은 새 구간 행으로(과거 구간 보존)
  check (active_to is null or active_to > active_from),
  check ((market = 'US') = (bench = 'COMP')),   -- 미국 = 나스닥 종합, 한국 = 코스피·코스닥
  check (market = 'KR' or not kr_financial)     -- 금융업 예외는 한국만
);

create table tikr_score.universe_log (
  id        bigserial primary key,
  market    text not null,
  symbol    text not null,
  action    text not null check (action in ('편입', '제외')),
  reason    text,
  effective date not null,
  logged_at timestamptz not null default now()
);

-- 펀더멘털·밸류에이션 스냅숏(주 1회). pe_hist는 최신 분기부터. 비교는 isnum()으로만.
create table tikr_score.fund_snapshot (
  market          text not null check (market in ('US', 'KR')),
  symbol          text not null,
  as_of           date not null,
  eps_ttm         double precision,
  rev_growth      double precision,
  debt_ratio_x    double precision,      -- 배수(1.0 = 100%)
  roe             double precision,
  equity_positive boolean,
  pe_now          double precision,
  pe_hist         double precision[],
  market_cap_usd  double precision,
  market_cap_krw  double precision,
  cap_source      text,
  primary key (market, symbol, as_of)
);

-- 모멘텀 원점수(평가일마다 확정값). 표시 점수·급변은 momentum_view에서 계산.
create table tikr_score.momentum_daily (
  market      text not null,
  symbol      text not null,
  d           date not null,
  n_closes    int,
  r1          double precision,
  r3          double precision,
  y           double precision,
  r1x         double precision,
  r3x         double precision,
  v           double precision,
  p3x         double precision,
  p1x         double precision,
  py          double precision,
  pv          double precision,
  pv_eff      double precision,
  halted      boolean not null default false,
  raw         double precision,
  status      text not null,
  surge       boolean not null default false,
  computed_at timestamptz not null default now(),
  primary key (market, symbol, d)
);

create index momentum_daily_market_d on tikr_score.momentum_daily (market, d);

-- 확정값 재산출 이력: 같은 평가일 확정값은 덮어쓰지 않는 것이 원칙. 데이터 정정으로 강제 재산출할 때만 이전 행을 보관.
create table tikr_score.momentum_hist (
  like tikr_score.momentum_daily,
  replaced_at timestamptz not null default now()
);

alter table tikr_score.px_daily       enable row level security;
alter table tikr_score.bench_daily    enable row level security;
alter table tikr_score.fx_daily       enable row level security;
alter table tikr_score.px_hold        enable row level security;
alter table tikr_score.universe       enable row level security;
alter table tikr_score.universe_log   enable row level security;
alter table tikr_score.fund_snapshot  enable row level security;
alter table tikr_score.momentum_daily enable row level security;
alter table tikr_score.momentum_hist  enable row level security;

-- 평가일 달력 = 나스닥 종합·코스피 거래일 합집합(수집기가 지수 누락 0을 보장)
create or replace view tikr_score.eval_calendar as
  select distinct d from tikr_score.bench_daily where code in ('COMP', 'KOSPI');

-- ── §3 모멘텀 원점수 ────────────────────────────────

create or replace function tikr_score.compute_momentum(p_market text, p_d date, p_force boolean default false)
returns int language plpgsql as $$
declare n_rows int;
begin
  -- 같은 시장·평가일 동시 실행 직렬화(확인 뒤 INSERT 기본키 충돌 방지)
  perform pg_advisory_xact_lock(hashtext('tikr_momentum:' || p_market), p_d - date '2000-01-01');
  -- 확정값은 덮어쓰지 않는다: 이미 있으면 건너뜀. 데이터 정정 때만 p_force → 이전 행은 momentum_hist에 보관 후 재산출
  if exists (select 1 from tikr_score.momentum_daily where market = p_market and d = p_d) then
    if p_force is not true then   -- NULL도 강제 아님(명시적 true만)
      return 0;
    end if;
    insert into tikr_score.momentum_hist
      select m.*, now() from tikr_score.momentum_daily m where m.market = p_market and m.d = p_d;
    delete from tikr_score.momentum_daily where market = p_market and d = p_d;
  end if;

  insert into tikr_score.momentum_daily
    (market, symbol, d, n_closes, r1, r3, y, r1x, r3x, v, p3x, p1x, py, pv, pv_eff, halted, raw, status, surge)
  with u as (   -- 평가일 당시 구성원(과거 재산출도 그때 모집단으로), 구간이 겹치면 가장 늦게 시작한 구간
    select distinct on (symbol) symbol, bench from tikr_score.universe
    where market = p_market and active_from <= p_d and (active_to is null or p_d < active_to)
    order by symbol, active_from desc
  ), px as (
    select p.symbol, p.d, p.close, p.volume, p.amount,
           row_number() over (partition by p.symbol order by p.d desc) as rn,
           count(*)     over (partition by p.symbol)                  as n
    from tikr_score.px_daily p
    join u on u.symbol = p.symbol
    where p.market = p_market and p.d <= p_d
  ), m as (
    select u.symbol, u.bench, coalesce(max(px.n), 0)::int as n,
           max(px.close) filter (where px.rn = 1)   as c0,   max(px.d) filter (where px.rn = 1)  as d0,
           max(px.close) filter (where px.rn = 22)  as c21,  max(px.d) filter (where px.rn = 22) as d21,
           max(px.close) filter (where px.rn = 64)  as c63,  max(px.d) filter (where px.rn = 64) as d63,
           max(px.close) filter (where px.rn = 253) as c252,
           avg(px.amount)   filter (where px.rn <= 20)             as a20,
           count(px.amount) filter (where px.rn <= 20)             as n20,
           avg(px.amount)   filter (where px.rn between 21 and 80) as a60,
           count(px.amount) filter (where px.rn between 21 and 80) as n60,
           count(*) filter (where px.rn <= 5 and px.volume = 0)    as zero5
    from u left join px on px.symbol = u.symbol
    group by u.symbol, u.bench
  ), b as (   -- 벤치마크는 종목 자신의 거래일 기준 as-of
    select m.*,
      (select bd.close from tikr_score.bench_daily bd where bd.code = m.bench and bd.d <= m.d0  order by bd.d desc limit 1) as b0,
      (select bd.close from tikr_score.bench_daily bd where bd.code = m.bench and bd.d <= m.d21 order by bd.d desc limit 1) as b21,
      (select bd.close from tikr_score.bench_daily bd where bd.code = m.bench and bd.d <= m.d63 order by bd.d desc limit 1) as b63
    from m
  ), r as (   -- 기간 수익률은 종가 N+1개, 거래대금 비율은 두 구간 모두 빠짐없이(20·60개)
    select b.symbol, b.n,
      (b.n >= 5 and b.zero5 = 5) as halted,
      (select h.reason from tikr_score.px_hold h   -- 최신 봉 날짜 ≤ 보류일 ≤ 평가일 중 가장 늦은 보류
        where h.market = p_market and h.symbol = b.symbol and h.d >= b.d0 and h.d <= p_d
        order by h.d desc limit 1) as hold_reason,
      case when b.n >= 22  then b.c0 / b.c21  - 1 end as r1,
      case when b.n >= 64  then b.c0 / b.c63  - 1 end as r3,
      case when b.n >= 253 then b.c0 / b.c252 - 1 end as y,
      case when b.n >= 22 and b.b0 is not null and b.b21 is not null then (b.c0 / b.c21 - 1) - (b.b0 / b.b21 - 1) end as r1x,
      case when b.n >= 64 and b.b0 is not null and b.b63 is not null then (b.c0 / b.c63 - 1) - (b.b0 / b.b63 - 1) end as r3x,
      case when b.n >= 80 and b.n20 = 20 and b.n60 = 60 and b.a60 > 0 then b.a20 / b.a60 end as v
    from b
  ), lng as (   -- 백분위 대상: 거래정지·산출 보류 제외, 유효값만
    select r.symbol, t.f, t.val
    from r cross join lateral (values ('r3x', r.r3x), ('r1x', r.r1x), ('y', r.y), ('v', r.v)) as t(f, val)
    where not r.halted and r.hold_reason is null and tikr_score.isnum(t.val)
  ), ranked as (   -- 평균 순위 백분위 (순위−1)/(N−1), N<20이면 결측
    select l.symbol, l.f,
      case when count(*) over (partition by l.f) >= 20 then
        ((rank() over (partition by l.f order by l.val))::float8
          + ((count(*) over (partition by l.f, l.val))::float8 - 1) / 2 - 1)
        / ((count(*) over (partition by l.f))::float8 - 1)
      end as p
    from lng l
  ), pw as (
    select symbol,
           max(p) filter (where f = 'r3x') as p3x,
           max(p) filter (where f = 'r1x') as p1x,
           max(p) filter (where f = 'y')   as py,
           max(p) filter (where f = 'v')   as pv
    from ranked group by symbol
  ), e as (   -- 거래대금: 백분위 먼저, 그 뒤 1M 수익률 ≤ 0이면 기여 0
    select r.*, pw.p3x, pw.p1x, pw.py, pw.pv,
      case when not tikr_score.isnum(pw.pv) then null
           when not tikr_score.isnum(r.r1) then null
           when r.r1 > 0 then pw.pv else 0::float8 end as pv_eff
    from r left join pw on pw.symbol = r.symbol
  ), a as (
    select e.*,
      (case when tikr_score.isnum(e.p3x)    then 0.40::float8 else 0 end
     + case when tikr_score.isnum(e.p1x)    then 0.25::float8 else 0 end
     + case when tikr_score.isnum(e.py)     then 0.15::float8 else 0 end
     + case when tikr_score.isnum(e.pv_eff) then 0.20::float8 else 0 end) as avail,
      (case when tikr_score.isnum(e.p3x)    then 0.40::float8 * e.p3x    else 0 end
     + case when tikr_score.isnum(e.p1x)    then 0.25::float8 * e.p1x    else 0 end
     + case when tikr_score.isnum(e.py)     then 0.15::float8 * e.py     else 0 end
     + case when tikr_score.isnum(e.pv_eff) then 0.20::float8 * e.pv_eff else 0 end) as wsum
    from e
  )
  select p_market, a.symbol, p_d, a.n, a.r1, a.r3, a.y, a.r1x, a.r3x, a.v,
         a.p3x, a.p1x, a.py, a.pv, a.pv_eff, a.halted,
         case when a.halted then null
              when a.hold_reason is not null then null
              when a.avail < 0.8 - 1e-9 then null
              else a.wsum / a.avail * 100 end,
         case when a.halted then '거래정지'
              when a.hold_reason is not null then a.hold_reason
              when a.avail < 0.8 - 1e-9 then '산출 불가'
              when a.avail < 1 - 1e-9 then '부분 산출'
              else '정상' end,
         coalesce(tikr_score.isnum(a.r1) and a.r1 >= 0.40 - 1e-9, false)
  from a;

  get diagnostics n_rows = row_count;
  return n_rows;
end $$;

-- 하루치 확정 산출(평가일 D): D+1 06:30 KST, 수집 완료 확인 뒤 1회. 미 D·한 D 확정 데이터로 두 시장 모두.
create or replace function tikr_score.run_daily(p_d date, p_force boolean default false)
returns int language plpgsql as $$
begin
  return tikr_score.compute_momentum('US', p_d, p_force) + tikr_score.compute_momentum('KR', p_d, p_force);
end $$;

-- 빠진 평가일만 채우기(장애 뒤). 이미 확정된 날은 건드리지 않는다(멱등).
create or replace function tikr_score.backfill_momentum(p_from date, p_to date)
returns int language plpgsql as $$
declare r record; n int := 0;
begin
  for r in select c.d from tikr_score.eval_calendar c where c.d between p_from and p_to order by c.d loop
    n := n + tikr_score.run_daily(r.d);
  end loop;
  return n;
end $$;

-- 보관: 일봉·지수·환율 약 2년(1Y 창 + 여유), 모멘텀 원점수 250일.
-- 250일 ≥ RPC 최대 60평가일 + 준비 5 + 표시 창 4(약 100 달력일)를 넉넉히 덮음 — 과거 조회·백필 여유 포함.
create or replace function tikr_score.prune(p_today date default current_date)
returns int language plpgsql as $$
declare n int := 0; k int;
begin
  delete from tikr_score.px_daily       where d < p_today - 800; get diagnostics k = row_count; n := n + k;
  delete from tikr_score.bench_daily    where d < p_today - 800; get diagnostics k = row_count; n := n + k;
  delete from tikr_score.fx_daily       where d < p_today - 800; get diagnostics k = row_count; n := n + k;
  delete from tikr_score.px_hold        where d < p_today - 800; get diagnostics k = row_count; n := n + k;
  delete from tikr_score.momentum_daily where d < p_today - 250; get diagnostics k = row_count; n := n + k;
  delete from tikr_score.momentum_hist  where d < p_today - 250; get diagnostics k = row_count; n := n + k;
  return n;
end $$;

-- 표시 점수 = 최근 5평가일(이전 4 + 오늘) 확정 원값 평균, 유효 3개 이상. 당일 원값이 결측이면 산출 보류.
-- 창은 행이 아니라 평가일 번호 기준(RANGE) — 편출 공백·빠진 산출일은 결측으로 센다. 원점수 급변도 바로 전 평가일과만 비교.
create or replace view tikr_score.momentum_view as
  with ec as (select c.d, (row_number() over (order by c.d))::int as ei from tikr_score.eval_calendar c)
  select m.*,
    case when not tikr_score.isnum(m.raw) then null
         when count(m.raw) over w >= 3 then avg(m.raw) over w
         else m.raw end as display,
    case when not tikr_score.isnum(m.raw) then '산출 보류'
         when count(m.raw) over w >= 3 then '5일 평균'
         else '평활 전' end as display_status,
    coalesce(lag(ec.ei) over p = ec.ei - 1 and abs(m.raw - lag(m.raw) over p) >= 20 - 1e-9, false) as raw_jump
  from tikr_score.momentum_daily m
  join ec on ec.d = m.d
  window p as (partition by m.market, m.symbol order by ec.ei),
         w as (partition by m.market, m.symbol order by ec.ei range between 4 preceding and current row);

-- 발견 목록: 평가일 당시 구성원 + 시총 통과(미 $2B·한 5,000억원) + 테마당 상위 2(테마 없으면 종목 단독). 시총 결측·비유한값은 제외.
create or replace function tikr_score.momentum_list(p_market text, p_d date, p_limit int default 20)
returns table (symbol text, theme text, display double precision, display_status text,
               raw double precision, status text, surge boolean, raw_jump boolean)
language sql stable as $$
  with v as (
    select mv.symbol, u.theme, mv.display, mv.display_status, mv.raw, mv.status, mv.surge, mv.raw_jump,
      (select f.market_cap_usd from tikr_score.fund_snapshot f
        where f.market = mv.market and f.symbol = mv.symbol and f.as_of <= p_d order by f.as_of desc limit 1) as cap_usd,
      (select f.market_cap_krw from tikr_score.fund_snapshot f
        where f.market = mv.market and f.symbol = mv.symbol and f.as_of <= p_d order by f.as_of desc limit 1) as cap_krw
    from tikr_score.momentum_view mv
    cross join lateral (
      select u.theme from tikr_score.universe u
      where u.market = mv.market and u.symbol = mv.symbol
        and u.active_from <= p_d and (u.active_to is null or p_d < u.active_to)
      order by u.active_from desc limit 1) u
    where mv.market = p_market and mv.d = p_d
      and tikr_score.isnum(mv.display)
  ), f as (
    select v.*, row_number() over (partition by case when nullif(v.theme, '') is null then 'S:' || v.symbol else 'T:' || v.theme end
                                   order by v.display desc, v.symbol collate "C") as rn_theme
    from v
    where (p_market = 'US' and tikr_score.isnum(v.cap_usd) and v.cap_usd >= 2e9)
       or (p_market = 'KR' and tikr_score.isnum(v.cap_krw) and v.cap_krw >= 5e11)
  )
  select f.symbol, f.theme, f.display, f.display_status, f.raw, f.status, f.surge, f.raw_jump
  from f where f.rn_theme <= 2
  order by f.display desc, f.symbol collate "C"
  limit p_limit
$$;

-- ── §4 펀더멘털 · §5 밸류에이션 ─────────────────────

create or replace function tikr_score.fund_label(p_eps double precision, p_rev double precision, p_debt_x double precision,
                                                 p_roe double precision, p_equity_pos boolean, p_kr_fin boolean default false)
returns jsonb language plpgsql immutable as $$
declare
  c_eps boolean; c_rev boolean; c_debt boolean; c_roe boolean; ev int; n int; lab text;
begin
  c_eps := case when tikr_score.isnum(p_eps) then p_eps > 0 end;
  c_rev := case when tikr_score.isnum(p_rev) then p_rev > 0 end;
  if p_equity_pos is false then          -- 자본잠식이 지표 결측보다 우선
    c_debt := false; c_roe := false;
  elsif p_equity_pos is null then
    c_debt := null;  c_roe := null;
  else
    c_debt := case when tikr_score.isnum(p_debt_x) then p_debt_x < 1.0 end;
    c_roe  := case when tikr_score.isnum(p_roe)    then p_roe > 10 end;
  end if;
  if p_kr_fin then                       -- 한국 금융업: 부채 '해당 없음', 3개 조건 판정(일반 기준과 결과 동치)
    ev := (c_eps is not null)::int + (c_rev is not null)::int + (c_roe is not null)::int;
    n  := coalesce(c_eps::int, 0) + coalesce(c_rev::int, 0) + coalesce(c_roe::int, 0);
    lab := case when ev < 3 then '산출 불가' when n = 3 then '양호' when n = 2 then '보통' else '취약' end;
    return jsonb_build_object('label', lab, 'eps', c_eps, 'rev', c_rev, 'debt', '해당 없음', 'roe', c_roe,
                              'capital_impaired', p_equity_pos is false);
  end if;
  ev := (c_eps is not null)::int + (c_rev is not null)::int + (c_debt is not null)::int + (c_roe is not null)::int;
  n  := coalesce(c_eps::int, 0) + coalesce(c_rev::int, 0) + coalesce(c_debt::int, 0) + coalesce(c_roe::int, 0);
  lab := case when ev < 3 then '산출 불가' when n >= 3 then '양호' when n = 2 then '보통' else '취약' end;
  return jsonb_build_object('label', lab, 'eps', c_eps, 'rev', c_rev, 'debt', c_debt, 'roe', c_roe,
                            'capital_impaired', p_equity_pos is false);
end $$;

create or replace function tikr_score.valuation_label(p_eps double precision, p_pe double precision, p_hist double precision[])
returns text language plpgsql immutable as $$
declare h double precision[]; cnt int; pos double precision;
begin
  if not tikr_score.isnum(p_eps) then return '산출 불가(EPS 결측)'; end if;
  if p_eps <= 0 then return '산출 불가(적자)'; end if;
  if not tikr_score.isnum(p_pe) or p_pe <= 0 then return '산출 불가(PER 결측·이상값)'; end if;
  select array_agg(t.x order by t.o) into h
    from unnest(p_hist[1:20]) with ordinality as t(x, o)
    where tikr_score.isnum(t.x) and t.x > 0;
  cnt := coalesce(array_length(h, 1), 0);
  if cnt < 12 then return format('산출 불가(이력 %s분기)', cnt); end if;
  select count(*)::float8 / cnt into pos from unnest(h) as x where x <= p_pe;
  return (case when pos >= 0.8 then '부담' when pos <= 0.2 then '낮음' else '보통' end)
      || (case when p_pe > 100 then ' · 극단값' else '' end);
end $$;

-- ── §7 포트폴리오 점수 ──────────────────────────────
-- p_holdings: [{"market":"US","symbol":"AAPL","qty":10}, {"market":"KR","symbol":"005930","qty":3}] — 저장하지 않음.
--   입력 방어: 배열 원소 중 객체·시장(US/KR)·문자열 종목 코드·수량(음이 아닌 10진수, 정수부 12자리·소수부 30자리 이하,
--   숫자 또는 숫자 문자열)만 인정, 같은 종목은 합산(합계 0 이하 제외). 벤치마크는 유니버스 최신 구간, 없으면 시장 기본.
--   오늘 가격(또는 환율)이 없는 보유는 비중에서 빠지고 '일부 보유 평가 제외' + 제외 수 표시, 전부 없으면 '보유 평가 불가'.
-- p_n: 1~60평가일(NULL은 30). 앞에 준비 5평가일을 더 계산(첫 반환일의 전일 5평가일 평균까지 온전하게 — p_n과 무관한 결과).
-- 각 평가일 t: 비중 = 그날 원화 평가액, 1Y 창 (t−365, t]·3M 창 (t−91, t], 시작 가격 = 창 시작일 as-of.
-- 가상 포트폴리오(일간 재조정). 휴장 시장 자산은 현지 가격 불변(환율 변동분만 원화 수익률에 반영).
-- 이력 부족 구간은 해당 벤치마크 수익률로 대체. 한 단계에 필요한 수익률이 하나라도 없으면 그 단계는 보류(편향 방지).
-- 변동성·초과수익은 포트폴리오·벤치마크 수익률이 모두 있는 단계만 사용(같은 날끼리 비교).
create or replace function tikr_score.portfolio_series(p_holdings jsonb, p_as_of date default null, p_n int default 30)
returns table (
  d date, total double precision,
  s_div double precision, s_mom double precision, s_vol double precision, s_exc double precision,
  max_w_pct double precision, vol_ratio double precision, n_returns int,
  exc_raw_pct double precision, exc_disp_pct double precision, exc_status text,
  subst_steps int, n_unvalued int, flags text[],
  d_div double precision, d_mom double precision, d_vol double precision, d_exc double precision,
  cause_item text, cause_symbol text
)
language sql stable
-- CTE에는 통계가 없어 행 수를 과소 추정 → (보유 × 1년 단계) 조인을 중첩 루프로 풀면 보유 50종목에서 수십 배 느려짐. 해시·병합 조인 강제.
set enable_nestloop = off
as $$
with
params as (
  select coalesce(p_as_of, (select max(c.d) from tikr_score.eval_calendar c)) as as_of
),
h0 as (   -- 수량 캐스트는 형식 검사를 통과한 값만(CASE 안에서)
  select e->>'market' as market, e->>'symbol' as symbol,
         case when (e->>'qty') ~ '^[0-9]{1,12}(\.[0-9]{1,30})?$' then (e->>'qty')::numeric end as qty
  from jsonb_array_elements(case when jsonb_typeof(p_holdings) = 'array' then p_holdings else '[]'::jsonb end) as e
  where jsonb_typeof(e) = 'object'
    and e->>'market' in ('US', 'KR')
    and jsonb_typeof(e->'symbol') = 'string' and e->>'symbol' <> ''
),
h as (
  select h0.market, h0.symbol, sum(h0.qty)::float8 as qty,
         coalesce((select u.bench from tikr_score.universe u where u.market = h0.market and u.symbol = h0.symbol
                   order by u.active_from desc limit 1),
                  case when h0.market = 'US' then 'COMP' else 'KOSPI' end) as bench
  from h0
  where h0.qty is not null
  group by h0.market, h0.symbol
  having sum(h0.qty) > 0
),
cal as (
  select c.d, row_number() over (order by c.d) as i
  from tikr_score.eval_calendar c, params where c.d <= params.as_of
),
evald as (
  select * from (select cal.d, cal.i from cal order by cal.d desc limit least(greatest(coalesce(p_n, 30), 1), 60) + 5) z
),
lo as (   -- 가장 이른 결과 평가일의 1Y 창 시작 as-of 앵커(그 이하 마지막 평가일)
  select coalesce((select max(cal.d) from cal where cal.d <= (select min(evald.d) from evald) - 365),
                  (select min(cal.d) from cal)) as lo_d
),
calw as (select cal.d, cal.i from cal, lo where cal.d >= lo.lo_d),
dayv as (   -- 날짜별 공유 as-of: 환율·지수(보유 종목마다 반복 조회하지 않음)
  select calw.d, calw.i,
    (select f.rate  from tikr_score.fx_daily f    where f.pair = 'USDKRW' and f.d <= calw.d order by f.d desc limit 1) as fx,
    (select b.close from tikr_score.bench_daily b where b.code = 'COMP'   and b.d <= calw.d order by b.d desc limit 1) as comp,
    (select b.close from tikr_score.bench_daily b where b.code = 'KOSPI'  and b.d <= calw.d order by b.d desc limit 1) as kospi,
    (select b.close from tikr_score.bench_daily b where b.code = 'KOSDAQ' and b.d <= calw.d order by b.d desc limit 1) as kosdaq
  from calw
),
ap as (   -- 보유 종목 as-of 가격(기본키 인덱스 역방향 1건 조회)
  select h.market, h.symbol, h.bench, dv.d, dv.i, dv.fx,
    case h.bench when 'COMP' then dv.comp when 'KOSPI' then dv.kospi else dv.kosdaq end as bx,
    (select p.close from tikr_score.px_daily p where p.market = h.market and p.symbol = h.symbol and p.d <= dv.d
      order by p.d desc limit 1) as px
  from h cross join dayv dv
),
akrw as (
  select ap.market, ap.symbol, ap.d, ap.i,
    ap.px * case when ap.market = 'US' then ap.fx else 1 end as p_krw,
    ap.bx * case when ap.bench = 'COMP' then ap.fx else 1 end as b_krw
  from ap
),
steps as materialized (   -- 평가일 간 일간 원화 수익률(1회 계산 — 인라인되면 조인마다 재계산됨)
  select a.market, a.symbol, a.d,
    a.p_krw / lag(a.p_krw) over w - 1 as r_raw,
    a.b_krw / lag(a.b_krw) over w - 1 as rb
  from akrw a
  window w as (partition by a.market, a.symbol order by a.i)
),
wt as (
  select e.d as t, e.i, a.market, a.symbol, h.qty * a.p_krw as val
  from evald e
  join akrw a on a.d = e.d
  join h on h.market = a.market and h.symbol = a.symbol
),
ws as (select wt.t, sum(wt.val) as tot from wt group by wt.t),
wn as (
  select wt.t, wt.i, wt.market, wt.symbol,
         case when ws.tot > 0 and wt.val is not null then wt.val / ws.tot end as w
  from wt join ws on ws.t = wt.t
),
prd as materialized (   -- (t, 단계, 보유) 상세. 단계 완전성·단계 수익률은 같은 (t, 단계)의 활성 보유(w 있음) 전부로 판정(윈도)
  select wn.t, wn.i, wn.market, wn.symbol, wn.w, s.d as sd, s.r_raw, s.rb,
    coalesce(s.r_raw, s.rb) as re,
    count(wn.w) over g                                                        as n_g,
    count(case when wn.w is not null then coalesce(s.r_raw, s.rb) end) over g as n_re,
    count(case when wn.w is not null then s.rb end) over g                     as n_rb,
    sum(wn.w * coalesce(s.r_raw, s.rb)) over g                                 as rp_g,
    sum(wn.w * s.rb) over g                                                    as rbm_g
  from wn
  join steps s on s.market = wn.market and s.symbol = wn.symbol and s.d > wn.t - 365 and s.d <= wn.t
  window g as (partition by wn.t, s.d)
),
pr as (   -- (t, 단계) 포트폴리오·구성 벤치마크 일간 수익률 — 구성 수익률이 하나라도 없으면 단계 보류
  select prd.t, prd.sd,
    max(case when prd.n_g = prd.n_re then prd.rp_g end)  as rp,
    max(case when prd.n_g = prd.n_rb then prd.rbm_g end) as rbm,
    sum(case when prd.w is not null and prd.r_raw is null and prd.rb is not null then 1 else 0 end)::int as nsub
  from prd
  where prd.n_g > 0
  group by prd.t, prd.sd
),
prl as (   -- 로그 수익률은 포트폴리오·벤치마크 둘 다 있는 단계만(같은 날끼리 비교)
  select pr.*,
    case when pr.rp > -1 and pr.rbm > -1 then ln(1 + pr.rp)  end as lp,
    case when pr.rp > -1 and pr.rbm > -1 then ln(1 + pr.rbm) end as lb
  from pr
),
agg as (
  select prl.t,
    count(prl.lp)::int as m_both,
    stddev_samp(prl.lp) as sp,
    stddev_samp(prl.lb) as sb,
    exp(sum(prl.lp) filter (where prl.sd > prl.t - 91)) - 1 as p3,
    exp(sum(prl.lb) filter (where prl.sd > prl.t - 91)) - 1 as b3,
    coalesce(sum(prl.nsub) filter (where prl.rp is not null), 0)::int as nsub
  from prl group by prl.t
),
r3i as materialized (   -- 종목별 3M 원화 수익률·벤치 수익률(원인 설명용) — 포트폴리오 초과수익과 같은 단계(공통 유효 단계)만.
           -- 3M 창에 t 당일이 늘 있어 (t, 보유)마다 한 행(아래 5평가일 창 정렬 유지)
  select prd.t, prd.i, prd.market, prd.symbol, prd.w,
    exp(sum(case when prd.n_g > 0 and prd.n_g = prd.n_re and prd.n_g = prd.n_rb and prd.rp_g > -1 and prd.rbm_g > -1
                  and prd.re > -1 and prd.rb > -1 then ln(1 + prd.re) end)) - 1 as r3,
    exp(sum(case when prd.n_g > 0 and prd.n_g = prd.n_re and prd.n_g = prd.n_rb and prd.rp_g > -1 and prd.rbm_g > -1
                  and prd.re > -1 and prd.rb > -1 then ln(1 + prd.rb) end)) - 1 as b3
  from prd
  where prd.sd > prd.t - 91
  group by prd.t, prd.i, prd.market, prd.symbol, prd.w
),
mrun as (   -- 평가일 t에 쓸 시장별 모멘텀 산출일 = t 이하 가장 최근 산출일. 당일 확정(D+1 06:30) 전이면 직전 확정값
  select e.d as t, mk.market,
    (select max(m.d) from tikr_score.momentum_daily m where m.market = mk.market and m.d <= e.d) as rd
  from evald e cross join (values ('US'::text), ('KR'::text)) as mk(market)
),
mvh as materialized (   -- 보유 종목의 모멘텀 표시값을 한 번만 모음(1회 계산 — 인라인되면 조인 행마다 뷰 전체를 재계산). d 조건은 창 계산 뒤에 적용됨
  select mv.market, mv.symbol, mv.d, mv.display
  from tikr_score.momentum_view mv
  join h on h.market = mv.market and h.symbol = mv.symbol
  where mv.d in (select mrun.rd from mrun)
),
mom as (   -- 표시 점수 없음(산출 보류·미편입)은 50점 중립
  select wn.t, wn.market, wn.symbol, wn.w,
    case when tikr_score.isnum(x.display) then x.display else 50::float8 end as disp,
    coalesce(r.rd < wn.t, false) as prior_run
  from wn
  left join mrun r on r.t = wn.t and r.market = wn.market
  left join mvh x on x.market = wn.market and x.symbol = wn.symbol and x.d = r.rd
  where wn.w is not null
),
wagg as (select wn.t, max(wn.w) * 100 as maxw, count(wn.w)::int as n_valued from wn group by wn.t),
magg as (select mom.t, 30 * sum(mom.w * mom.disp / 100) as s_mom, bool_or(mom.prior_run) as mom_prior from mom group by mom.t),
base as (
  select e.d as t, e.i, wagg.maxw, coalesce(wagg.n_valued, 0) as n_valued, magg.s_mom, coalesce(magg.mom_prior, false) as mom_prior,
    agg.m_both, agg.sp, agg.sb, agg.nsub,
    case when agg.p3 is not null and agg.b3 is not null then (agg.p3 - agg.b3) * 100 end as exc_raw
  from evald e
  left join wagg on wagg.t = e.d
  left join magg on magg.t = e.d
  left join agg on agg.t = e.d
),
cs as (   -- 초과수익 기여 ≈ w × (종목 3M − 벤치 3M): 포트폴리오 원값이 있는 날만 정의, 비중 없는 보유는 0
  select r3i.t, r3i.i, r3i.market, r3i.symbol,
    case when b.exc_raw is not null then coalesce(r3i.w * (r3i.r3 - r3i.b3), 0) end as c
  from r3i join base b on b.t = r3i.t
),
cs5 as (   -- 기여도 평활도 표시값과 같은 규칙: 당일 결측이면 결측, 유효 3개 이상이면 5평가일 평균, 아니면 당일 값
  select cs.t, cs.market, cs.symbol,
    case when cs.c is null then null
         when count(cs.c) over w >= 3 then avg(cs.c) over w
         else cs.c end as c5
  from cs
  window w as (partition by cs.market, cs.symbol order by cs.i rows between 4 preceding and current row)
),
disp as (   -- 초과수익 표시 = 이전 4 + 오늘 원값 평균(유효 3개 이상), 오늘 결측이면 보류
  select base.*,
    count(base.exc_raw) over w5 as nvalid,
    avg(base.exc_raw)   over w5 as avg5
  from base
  window w5 as (order by base.i rows between 4 preceding and current row)
),
sc as (
  select disp.t, disp.i, disp.maxw, disp.n_valued, disp.mom_prior, disp.m_both, disp.nsub, disp.exc_raw,
    case when not tikr_score.isnum(disp.exc_raw) then null
         when disp.nvalid >= 3 then disp.avg5 else disp.exc_raw end as exc_disp,
    case when not tikr_score.isnum(disp.exc_raw) then '산출 보류'
         when disp.nvalid >= 3 then '5일 평균' else '평활 전' end as exc_status,
    case when disp.m_both >= 200 and disp.sb > 0 then disp.sp / disp.sb end as vol_ratio,
    25 * tikr_score.clamp01((50 - disp.maxw) / 30) as s_div,
    disp.s_mom
  from disp
),
sc2 as (
  select sc.*,
    25 * tikr_score.clamp01(2 - sc.vol_ratio)        as s_vol,
    20 * tikr_score.clamp01((sc.exc_disp + 10) / 20) as s_exc
  from sc
),
fin as (
  select sc2.*,
    coalesce(sc2.s_div, 12.5) as e_div, coalesce(sc2.s_mom, 15) as e_mom,
    coalesce(sc2.s_vol, 12.5) as e_vol, coalesce(sc2.s_exc, 10) as e_exc
  from sc2
),
fin1 as (   -- 평가액 있는 보유가 하나도 없으면 총점 산출 불가(중립 50점으로 보이지 않게)
  select fin.*,
    fin.maxw is not null as valued,
    case when fin.maxw is not null then fin.e_div + fin.e_mom + fin.e_vol + fin.e_exc end as total,
    lag(fin.exc_raw) over (order by fin.i)             as prev_exc_raw,
    lag(fin.maxw is not null) over (order by fin.i)    as prev_valued
  from fin
),
fin2 as (
  select fin1.*,
    case when fin1.valued and fin1.prev_valued then fin1.e_div - lag(fin1.e_div) over (order by fin1.i) end as d_div,
    case when fin1.valued and fin1.prev_valued then fin1.e_mom - lag(fin1.e_mom) over (order by fin1.i) end as d_mom,
    case when fin1.valued and fin1.prev_valued then fin1.e_vol - lag(fin1.e_vol) over (order by fin1.i) end as d_vol,
    case when fin1.valued and fin1.prev_valued then fin1.e_exc - lag(fin1.e_exc) over (order by fin1.i) end as d_exc,
    lag(fin1.t) over (order by fin1.i) as prev_t
  from fin1
),
top as (   -- 전일 대비 가장 큰 항목(동률은 분산·모멘텀·변동성·초과수익 순, 전부 1e-9 미만이면 없음)
  select fin2.t,
    (select k.item from (values ('div', fin2.d_div, 1), ('mom', fin2.d_mom, 2), ('vol', fin2.d_vol, 3), ('exc', fin2.d_exc, 4)) as k(item, dv, ord)
      where k.dv is not null and abs(k.dv) >= 1e-9 order by abs(k.dv) desc, k.ord limit 1) as item
  from fin2
),
cause as (   -- 그 항목에서 가장 크게 기여한 종목(분산: 비중 변화 · 모멘텀: w×표시점수 변화 · 초과수익: 평균 기여 변화 · 변동성: 없음)
  select fin2.t, top.item,
    case top.item
      when 'div' then (select a.symbol from wn a join wn b on b.market = a.market and b.symbol = a.symbol and b.t = fin2.prev_t
                        where a.t = fin2.t order by abs(coalesce(a.w, 0) - coalesce(b.w, 0)) desc, a.symbol collate "C", a.market limit 1)
      when 'mom' then (select a.symbol from wn a join wn b on b.market = a.market and b.symbol = a.symbol and b.t = fin2.prev_t
                        left join mom ma on ma.t = a.t and ma.market = a.market and ma.symbol = a.symbol
                        left join mom mb on mb.t = b.t and mb.market = b.market and mb.symbol = b.symbol
                        where a.t = fin2.t
                        order by abs(coalesce(ma.w * ma.disp, 0) - coalesce(mb.w * mb.disp, 0)) desc, a.symbol collate "C", a.market limit 1)
      when 'exc' then (select a.symbol from cs5 a join cs5 b on b.market = a.market and b.symbol = a.symbol and b.t = fin2.prev_t
                        where a.t = fin2.t order by abs(coalesce(a.c5, 0) - coalesce(b.c5, 0)) desc, a.symbol collate "C", a.market limit 1)
    end as symbol
  from fin2 join top on top.t = fin2.t
  where fin2.prev_t is not null and fin2.valued and fin2.prev_valued
)
select fin2.t, fin2.total, fin2.s_div, fin2.s_mom, fin2.s_vol, fin2.s_exc,
       fin2.maxw, fin2.vol_ratio, fin2.m_both, fin2.exc_raw, fin2.exc_disp, fin2.exc_status, coalesce(fin2.nsub, 0),
       (select count(*) from h)::int - fin2.n_valued,
       case when not fin2.valued then array['보유 평가 불가'] else array_remove(array[
         case when fin2.s_div is null then 'div 산출 보류(중립)' end,
         case when fin2.s_mom is null then 'mom 산출 보류(중립)' end,
         case when fin2.s_vol is null then 'vol 산출 보류(중립)' end,
         case when fin2.s_exc is null then 'exc 산출 보류(중립)' end,
         case when coalesce(fin2.nsub, 0) > 0 then '대체 적용' end,
         case when fin2.n_valued < (select count(*) from h) then '일부 보유 평가 제외' end,
         case when fin2.mom_prior then '모멘텀 직전 산출 사용' end,
         case when fin2.exc_status = '평활 전' then '초과수익 평활 전' end,
         case when tikr_score.isnum(fin2.exc_raw) and tikr_score.isnum(fin2.prev_exc_raw)
                   and abs(fin2.exc_raw - fin2.prev_exc_raw) >= 3 - 1e-9 then '초과수익 원값 급변' end
       ], null) end,
       fin2.d_div, fin2.d_mom, fin2.d_vol, fin2.d_exc,
       cause.item, cause.symbol
from fin2 left join cause on cause.t = fin2.t
where fin2.t in (select z.d from (select evald.d from evald order by evald.d desc limit least(greatest(coalesce(p_n, 30), 1), 60)) z)
  and exists (select 1 from h)                  -- 유효 보유 없음 → 결과 없음
order by fin2.t
$$;

-- ── 앱용 RPC(공개 스키마 래퍼) ──────────────────────
-- tikr_score 스키마는 API에 노출하지 않고, 결과만 돌려주는 함수만 공개한다.
-- 공개 RPC 상한: 보유 50종목, 기간 60평가일(앱 키로 누구나 호출 가능하므로 과도한 계산 방지).
-- 실측(PGlite WASM, 실제 PG보다 느림): 수 종목×30일 약 0.5초, 50종목×30일 3.4초, 50종목×60일 5.8초 — 계산량 ∝ 보유 수 × (평가일 + 5) × 1년 단계.

create or replace function public.tikr_portfolio_score_json(p_holdings jsonb, p_as_of date default null, p_n int default 30)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select case
    when jsonb_typeof(p_holdings) is distinct from 'array' or jsonb_array_length(p_holdings) > 50
      then jsonb_build_object('error', '보유 목록은 50종목 이하 배열이어야 해요')
    else (select coalesce(jsonb_agg(to_jsonb(s) order by s.d), '[]'::jsonb)
          from tikr_score.portfolio_series(p_holdings, p_as_of, least(greatest(coalesce(p_n, 30), 1), 60)) s)
  end
$$;

create or replace function public.tikr_momentum_list_json(p_market text, p_d date default null, p_limit int default 20)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(s) order by s.display desc, s.symbol collate "C"), '[]'::jsonb)
  from tikr_score.momentum_list(p_market, coalesce(p_d, (select max(m.d) from tikr_score.momentum_daily m where m.market = p_market)),
                                least(greatest(coalesce(p_limit, 20), 1), 50)) s
$$;

-- 내부 스키마: 함수 기본 실행 권한(PUBLIC) 회수 — 앱 키로 계산 함수를 직접 부르지 못하게
revoke all on schema tikr_score from public;
revoke execute on all functions in schema tikr_score from public;
revoke all on all tables in schema tikr_score from public;

revoke all on function public.tikr_portfolio_score_json(jsonb, date, int) from public;
revoke all on function public.tikr_momentum_list_json(text, date, int) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function public.tikr_portfolio_score_json(jsonb, date, int) to anon, authenticated;
    grant execute on function public.tikr_momentum_list_json(text, date, int) to anon, authenticated;
  end if;
end $$;
