// tikr-collect 순수 로직(외부 호출·Deno API 없음) — test/tikr-collect.test.mjs가 타입만 지우고 그대로 실행한다.
// 규칙 원본: 볼트 「점수기준서_v1」 §10, 참조 구현 ref_v13.py(drop_incomplete_bar·price_2source·resolve_conflict·market_cap_usd).

export type Market = "US" | "KR";
export type Bar = { d: string; close: number; volume: number | null; amount: number | null };
export type Point = { d: string; v: number };

const DAY = 86_400_000;

// ── 시각 ─────────────────────────────────────────────

const TZ: Record<Market, string> = { US: "America/New_York", KR: "Asia/Seoul" };
// 장 마감 + 30분 유예(분). 미국 16:00 ET, 한국 15:30 KST.
const READY_MIN: Record<Market, number> = { US: 16 * 60 + 30, KR: 16 * 60 };

export function zoned(now: Date, tz: string): { date: string; minutes: number; weekday: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
    }).formatToParts(now).map((x) => [x.type, x.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute, weekday };
}

export function addDays(d: string, n: number): string {
  return new Date(Date.parse(d + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
}

function weekdayOf(d: string): number {
  return new Date(d + "T00:00:00Z").getUTCDay();
}

function prevWeekday(d: string): string {
  let x = addDays(d, -1);
  while (weekdayOf(x) === 0 || weekdayOf(x) === 6) x = addDays(x, -1);
  return x;
}

// 그 시장에서 확정(마감 + 30분)된 가장 최근 평일(현지 날짜). 휴장일이면 그날 봉이 없을 뿐 — 달력 대조는 DB가 한다.
export function lastSession(now: Date, market: Market): string {
  const z = zoned(now, TZ[market]);
  if (z.weekday >= 1 && z.weekday <= 5 && z.minutes >= READY_MIN[market]) return z.date;
  return prevWeekday(z.date);
}

// 미완성 봉 제외(ref drop_incomplete_bar): 현지 '오늘' 봉은 마감 + 30분 전이면 버린다. 미래 날짜는 항상 버린다.
export function dropIncomplete<T extends { d: string }>(rows: T[], now: Date, market: Market): T[] {
  const z = zoned(now, TZ[market]);
  return rows.filter((r) => r.d < z.date || (r.d === z.date && z.minutes >= READY_MIN[market]));
}

// ── 호출 권한 ────────────────────────────────────────
// Authorization Bearer JWT의 role(서명 검증은 하지 않음 — 게이트웨이 verify_jwt가 먼저 검증한다는 전제).
export function bearerRole(auth: string | null): string | null {
  const part = (auth ?? "").replace(/^Bearer\s+/i, "").split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const role = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)))?.role;
    return typeof role === "string" ? role : null;
  } catch {
    return null;
  }
}

// KIS 해외 종목 코드: 클래스 주식은 '/'(BRK/B). 유니버스·Finnhub 표기는 '.'(BRK.B).
export const kisUsSymbol = (s: string) => s.replace(/\./g, "/");

// ── KIS 응답 파싱 ────────────────────────────────────

function ymd(s: unknown): string | null {
  const t = typeof s === "string" ? s.trim() : "";
  if (!/^\d{8}$/.test(t)) return null;
  const d = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
  return Number.isNaN(Date.parse(d + "T00:00:00Z")) || addDays(d, 0) !== d ? null : d;
}

// 가격: 0보다 크고 유한. 거래량·거래대금: 결측 또는 0 이상 유한(DB 저장 제약과 같음).
export function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = typeof v === "string" ? v.trim() : v;
  if (s === "") return null;
  const x = typeof s === "number" ? s : Number(s);
  return Number.isFinite(x) ? x : null;
}
const pos = (v: unknown) => { const x = num(v); return x !== null && x > 0 ? x : null; };
const nonneg = (v: unknown) => { const x = num(v); return x !== null && x >= 0 ? x : null; };

function toBars(list: unknown, key: { d: string; c: string; v?: string; a?: string }): Bar[] {
  const out = new Map<string, Bar>();
  for (const r of Array.isArray(list) ? list : []) {
    const d = ymd(r?.[key.d]);
    const close = pos(r?.[key.c]);
    if (!d || close === null) continue;   // KIS는 빈 칸('')으로 채운 행을 섞어 보낸다
    out.set(d, { d, close, volume: key.v ? nonneg(r[key.v]) : null, amount: key.a ? nonneg(r[key.a]) : null });
  }
  return [...out.values()].sort((a, b) => (a.d < b.d ? -1 : 1));
}

// 해외 기간별시세 HHDFS76240000(수정주가 MODP=1): xymd·clos·tvol·tamt(USD)
export const parseUsDaily = (o: unknown) => toBars(o, { d: "xymd", c: "clos", v: "tvol", a: "tamt" });
// 국내 기간별시세 FHKST03010100(수정주가): stck_bsop_date·stck_clpr·acml_vol·acml_tr_pbmn(원)
export const parseKrDaily = (o: unknown) => toBars(o, { d: "stck_bsop_date", c: "stck_clpr", v: "acml_vol", a: "acml_tr_pbmn" });
// 해외 지수·환율 FHKST03030100: stck_bsop_date·ovrs_nmix_prpr
export const parseOverseasChart = (o: unknown): Point[] =>
  toBars(o, { d: "stck_bsop_date", c: "ovrs_nmix_prpr" }).map((b) => ({ d: b.d, v: b.close }));
// 국내 업종 FHKUP03500100: stck_bsop_date·bstp_nmix_prpr
export const parseKrIndex = (o: unknown): Point[] =>
  toBars(o, { d: "stck_bsop_date", c: "bstp_nmix_prpr" }).map((b) => ({ d: b.d, v: b.close }));

// 매일 수집에서 DB로 보낼 봉: 마지막 저장일 7일 전부터(겹침 약 5거래일 — 수정주가 변경 감지와 빈 날 채우기는 유지,
// 함수→DB 전송은 최소). 저장 이력이 없으면(전체 수집) 그대로.
export function recentForIngest<T extends { d: string }>(bars: T[], lastD: string | null, overlapDays = 7): T[] {
  if (!lastD) return bars;
  const from = addDays(lastD, -overlapDays);
  return bars.filter((b) => b.d >= from);
}

// ── 지수·환율 겹침 수집 ───────────────────────────────
// KIS 차트 API는 요청마다 구간 경계 날짜를 다르게 빠뜨린다 → 25일 창을 20일씩 옮겨 겹치게 받고 합친다.
// 매일 수집: 끝을 오늘 + 4일로 잡아 최근 날짜가 창의 경계에 오지 않게 한다.

export type Window = { from: string; to: string };

export function seriesWindows(today: string, from?: string): Window[] {
  const start = from ?? addDays(today, -52);
  const out: Window[] = [];
  for (let end = addDays(today, 4); addDays(end, -24) > addDays(start, -20); end = addDays(end, -20)) {
    out.push({ from: addDays(end, -24), to: end });
  }
  return out;
}

// ref resolve_conflict: 같은 날짜의 값(소수 8자리 반올림)이 모두 같으면 채택, 다르면 충돌.
export function mergeSeries(results: Point[][]): { rows: Point[]; conflicts: { d: string; vals: number[] }[] } {
  const byDate = new Map<string, number[]>();
  for (const pts of results) for (const p of pts) byDate.set(p.d, [...(byDate.get(p.d) ?? []), p.v]);
  const rows: Point[] = [];
  const conflicts: { d: string; vals: number[] }[] = [];
  for (const [d, vals] of [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const r = new Set(vals.map((v) => Math.round(v * 1e8) / 1e8));
    if (r.size === 1) rows.push({ d, v: [...r][0] });
    else conflicts.push({ d, vals });
  }
  return { rows, conflicts };
}

// ── 가격 2출처 대조(미국) ─────────────────────────────
// Finnhub quote는 장 마감 뒤에도 c = 그 세션 종가, pc = 그 전 세션 종가(다음 세션 시작 때 바뀜).
// 확정 산출(D+1 06:30 KST) 시점엔 c가 D 종가 → t(마지막 체결 시각)의 미국 날짜로 같은 거래일인지 확인해 고른다.
export type FhQuote = { c?: number; pc?: number; t?: number };

export function finnhubSameDay(q: FhQuote, d: string): { price: number; field: "c" | "pc"; date: string } | null {
  const t = num(q?.t);
  if (t === null || t <= 0) return null;
  const tz = zoned(new Date(t * 1000), TZ.US);
  const tDate = tz.date;
  const c = pos(q.c), pc = pos(q.pc);
  // c는 정규장 종가일 때만(마지막 체결이 16:05 ET 이하). 시간외 가격이면 비교하지 않는다.
  if (tDate === d && tz.minutes <= 16 * 60 + 5 && c !== null) return { price: c, field: "c", date: tDate };
  if (tDate > d && prevWeekday(tDate) === d && pc !== null) return { price: pc, field: "pc", date: d };
  return null;   // 날짜가 맞는 값이 없음 → 비교 보류(산출 보류로 만들지 않는다)
}

// ref price_2source: 같은 거래일일 때만, |KIS ÷ Finnhub − 1| ≤ 0.5%면 일치.
export function price2Source(kis: number, ref: number, tol = 0.005): { ok: boolean; diff: number } {
  const diff = Math.abs(kis / ref - 1);
  return { ok: diff <= tol, diff };
}

// ── 재무 스냅숏 ──────────────────────────────────────

export type FundRow = {
  market: Market; symbol: string; as_of: string;
  eps_ttm: number | null; rev_growth: number | null; debt_ratio_x: number | null; roe: number | null;
  equity_positive: boolean | null; pe_now: number | null; pe_hist: number[] | null;
  market_cap_usd: number | null; market_cap_krw: number | null; cap_source: string | null;
};

// ref market_cap_usd: Finnhub(회사 전체, 통화 USD) 우선. 비USD 보고(ADR)만 KIS tomv(상장 주식 기준 USD)로 대체.
export function marketCapUsd(fhCapM: unknown, fhCurrency: string | null, kisTomv: unknown, kisCurrency: string | null) {
  if (fhCurrency === "USD") {
    const m = num(fhCapM);
    return m !== null ? { cap: m * 1e6, source: "Finnhub" } : { cap: null, source: null };
  }
  const t = num(kisTomv);
  if (fhCurrency && t !== null && kisCurrency === "USD") return { cap: t, source: "KIS 대체(비USD 보고 · 상장 주식 기준)" };
  return { cap: null, source: null };
}

// 미국: Finnhub /stock/metric(metric=all). 흑자·PER은 Finnhub만(KIS 해외 epsx·perx는 부호 누락).
export function usFund(symbol: string, asOf: string, body: any, currency: string | null,
                       kisTomv: unknown = null, kisCurrency: string | null = null): FundRow {
  const m = body?.metric ?? {};
  const bv = num(m.bookValuePerShareQuarterly) ?? num(m.bookValuePerShareAnnual);
  const hist = (Array.isArray(body?.series?.quarterly?.peTTM) ? body.series.quarterly.peTTM : [])
    .filter((x: any) => typeof x?.period === "string")
    .sort((a: any, b: any) => (a.period < b.period ? 1 : -1))   // 최신 분기부터
    .map((x: any) => num(x.v))
    .slice(0, 20);
  const cap = marketCapUsd(m.marketCapitalization, currency, kisTomv, kisCurrency);
  return {
    market: "US", symbol, as_of: asOf,
    eps_ttm: num(m.epsTTM), rev_growth: num(m.revenueGrowthTTMYoy),
    debt_ratio_x: num(m["totalDebt/totalEquityQuarterly"]), roe: num(m.roeTTM),
    equity_positive: bv === null ? null : bv > 0,
    pe_now: num(m.peTTM), pe_hist: hist.length ? hist : null,
    market_cap_usd: cap.cap, market_cap_krw: null, cap_source: cap.source,
  };
}

// 한국: KIS 현재가 FHKST01010100(eps·per·bps·hts_avls 억원) + 재무비율 FHKST66430300(grs·roe_val·lblt_rate %, 최신 기간).
export function krFund(symbol: string, asOf: string, price: any, ratios: unknown): FundRow {
  const latest = (Array.isArray(ratios) ? ratios : [])
    .filter((r: any) => typeof r?.stac_yymm === "string" && r.stac_yymm.trim() !== "")
    .sort((a: any, b: any) => (a.stac_yymm < b.stac_yymm ? 1 : -1))[0] ?? {};
  const bps = num(price?.bps);
  const lblt = num(latest.lblt_rate);
  const avls = num(price?.hts_avls);
  return {
    market: "KR", symbol, as_of: asOf,
    eps_ttm: num(price?.eps), rev_growth: num(latest.grs),
    debt_ratio_x: lblt === null ? null : lblt / 100, roe: num(latest.roe_val),
    equity_positive: bps === null ? null : bps > 0,
    pe_now: num(price?.per), pe_hist: null,
    market_cap_usd: null, market_cap_krw: avls === null ? null : avls * 1e8, cap_source: avls === null ? null : "KIS",
  };
}
