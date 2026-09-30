import { createClient } from "jsr:@supabase/supabase-js@2";
import * as L from "./logic.ts";

// 티커 점수 수집기 — 점수 엔진(tikr_score) 입력: 확정 일봉·지수·환율·재무 스냅숏·산출 보류(가격 2출처 불일치).
// 규칙: 볼트 「점수기준서_v1」 §10 · 「수집기_설계」. 계산은 DB 안에서(run_daily), 이 함수는 넣기만 한다.
//   · 작업 대기열(tikr_score.collect_task)을 조금씩 빌려 처리 — 한 번 호출(벽시계 150초) 안에 못 끝낸 몫은 다음 크론이 잇는다.
//   · 전송량: DB에서 큰 데이터를 읽지 않는다(빌린 작업 목록·요약 응답만, 수 KB). 외부 API 응답은 전송량에 안 잡힌다.
// 요청 body.job
//   kr       평일 16:05 KST~ : 한국 일봉·코스피·코스닥·환율(당일)
//   us       화~토 06:35 KST~ : (남은 한국 몫) → 미국 일봉·나스닥 종합·환율 → Finnhub 2출처 대조 → 확정 산출(run)·정리(prune)
//   fund     토 07:30 KST~    : 재무 스냅숏(미국 Finnhub, 한국 KIS)
//   backfill 수동 {from, plan?, items?} : from부터 오늘까지 과거 일봉·지수·환율 전체

const KIS = Deno.env.get("KIS_BASE_URL") ?? "https://openapi.koreainvestment.com:9443";
const KIS_APP_KEY = Deno.env.get("KIS_APP_KEY")!;
const KIS_APP_SECRET = Deno.env.get("KIS_APP_SECRET")!;
const FINNHUB_API_KEY = Deno.env.get("FINNHUB_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const BUDGET_MS = 110_000;   // 벽시계 150초 제한 안에서 여유
const KIS_GAP_MS = 250;      // KIS 초당 거래건수 제한 — 다른 함수 몫을 남기고 초당 4건
const FH_GAP_MS = 1_100;     // Finnhub 무료 분당 60회
const LEASE = 8;             // 한 번에 빌리는 작업 수(시간이 모자라면 반납)
const HISTORY_DAYS = 500;    // 전체 재수집 기간(1Y 창 + 조회 60평가일 + 준비 5 + 여유)
const CURRENCY_TTL_DAYS = 30;

const SERIES: Record<string, { code: string; market: L.Market }> = {
  "#COMP": { code: "COMP", market: "US" },
  "#KOSPI": { code: "KOSPI", market: "KR" },
  "#KOSDAQ": { code: "KOSDAQ", market: "KR" },
  "#FX": { code: "USDKRW", market: "KR" },   // 원/달러: 한국 날짜, 16:00 KST 전 오늘 값은 미완성
};

type Task = {
  market: L.Market; symbol: string; tries: number; note: string | null;
  excd: string | null; currency: string | null; currency_at: string | null; close: number | null; last_d: string | null;
};
type Outcome = [status: "done" | "failed" | "retry" | "release", note: string | null];

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const compact = (d: string) => d.replaceAll("-", "");

const lastCall: Record<string, number> = {};
async function pace(key: string, gap: number) {
  const wait = (lastCall[key] ?? 0) + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall[key] = Date.now();
}

async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

// ── 외부 API ─────────────────────────────────────────

let kisToken: string | null = null;
async function token(): Promise<string> {
  if (kisToken) return kisToken;
  const res = await fetch(`${SUPABASE_URL}/functions/v1/kis-auth`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`kis-auth 호출 실패 (${res.status})`);
  kisToken = (await res.json()).access_token;
  return kisToken!;
}

async function kisGet(path: string, trId: string, params: Record<string, string>): Promise<any> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await pace("kis", KIS_GAP_MS);
    const url = new URL(KIS + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      headers: {
        "content-type": "application/json", authorization: `Bearer ${await token()}`,
        appkey: KIS_APP_KEY, appsecret: KIS_APP_SECRET, tr_id: trId, custtype: "P",
      },
    });
    const body = await res.json().catch(() => null);
    if (res.ok && body?.rt_cd === "0") return body;
    // 초당 거래건수 초과(EGW00201)·서버 오류만 잠시 뒤 재시도
    if (body?.msg_cd !== "EGW00201" && res.status < 500) {
      throw new Error(`KIS ${trId} ${res.status} ${body?.msg_cd ?? ""} ${body?.msg1 ?? ""}`.trim());
    }
    await sleep(1_000 * (attempt + 1));
  }
  throw new Error(`KIS ${trId} 재시도 초과`);
}

async function fhGet(path: string, params: Record<string, string>): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await pace("fh", FH_GAP_MS);
    const url = new URL(`https://finnhub.io/api/v1${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("token", FINNHUB_API_KEY);
    const res = await fetch(url);
    if (res.ok) return await res.json();
    await res.body?.cancel();
    if (res.status !== 429 && res.status < 500) throw new Error(`Finnhub ${path} ${res.status}`);   // URL엔 키가 있어 싣지 않음
    await sleep(2_000);
  }
  throw new Error(`Finnhub ${path} 재시도 초과`);
}

// 미국 일봉(수정주가 MODP=1). 1회 100건, from이 있으면 BYMD로 과거 페이지를 이어 붙인다.
async function usDaily(excd: string, symbol: string, from: string | null): Promise<L.Bar[]> {
  const out = new Map<string, L.Bar>();
  let bymd = "";
  for (let page = 0; page < 8; page++) {
    const body = await kisGet("/uapi/overseas-price/v1/quotations/dailyprice", "HHDFS76240000",
      { AUTH: "", EXCD: excd, SYMB: L.kisUsSymbol(symbol), GUBN: "0", BYMD: bymd, MODP: "1" });
    const bars = L.parseUsDaily(body.output2);
    for (const b of bars) out.set(b.d, b);
    if (!from || bars.length === 0 || bars[0].d <= from) break;
    bymd = compact(L.addDays(bars[0].d, -1));
  }
  return [...out.values()].filter((b) => !from || b.d >= from).sort((a, b) => (a.d < b.d ? -1 : 1));
}

// 국내 일봉(수정주가 FID_ORG_ADJ_PRC=0). 1회 100건 한도 → 120일(약 83거래일) 단위로 쪼갠다.
async function krDaily(code: string, from: string, to: string): Promise<L.Bar[]> {
  const out = new Map<string, L.Bar>();
  for (let end = to; end >= from;) {
    const start = L.addDays(end, -119) < from ? from : L.addDays(end, -119);
    const body = await kisGet("/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice", "FHKST03010100", {
      FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code, FID_INPUT_DATE_1: compact(start),
      FID_INPUT_DATE_2: compact(end), FID_PERIOD_DIV_CODE: "D", FID_ORG_ADJ_PRC: "0",
    });
    for (const b of L.parseKrDaily(body.output2)) out.set(b.d, b);
    end = L.addDays(start, -1);
  }
  return [...out.values()].sort((a, b) => (a.d < b.d ? -1 : 1));
}

async function seriesWindow(code: string, w: L.Window): Promise<L.Point[]> {
  const range = { FID_INPUT_DATE_1: compact(w.from), FID_INPUT_DATE_2: compact(w.to), FID_PERIOD_DIV_CODE: "D" };
  if (code === "KOSPI" || code === "KOSDAQ") {
    const body = await kisGet("/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice", "FHKUP03500100",
      { FID_COND_MRKT_DIV_CODE: "U", FID_INPUT_ISCD: code === "KOSPI" ? "0001" : "1001", ...range });
    return L.parseKrIndex(body.output2);
  }
  const fx = code === "USDKRW";
  const body = await kisGet("/uapi/overseas-price/v1/quotations/inquire-daily-chartprice", "FHKST03030100",
    { FID_COND_MRKT_DIV_CODE: fx ? "X" : "N", FID_INPUT_ISCD: fx ? "FX@KRW" : "COMP", ...range });
  return L.parseOverseasChart(body.output2);
}

// 겹침 창으로 받아 합치고, 같은 날짜 값이 다르면 그 날짜가 든 창만 최대 2회 다시 받는다.
// 끝까지 다르면 충돌로 넘긴다 → DB가 직전 저장값 유지(없으면 그 날짜 보류) + 충돌 기록.
async function collectSeries(code: string, market: L.Market, now: Date, from?: string) {
  const windows = L.seriesWindows(L.zoned(now, market === "US" ? "America/New_York" : "Asia/Seoul").date, from);
  const fetchAll = async (ws: L.Window[]) => {
    const res: L.Point[][] = [];
    for (const w of ws) res.push(L.dropIncomplete(await seriesWindow(code, w), now, market));
    return res;
  };
  const first = L.mergeSeries(await fetchAll(windows));
  const rows = new Map(first.rows.map((p) => [p.d, p.v]));
  let conflicts = first.conflicts;
  for (let attempt = 0; attempt < 2 && conflicts.length > 0; attempt++) {
    const redo = windows.filter((w) => conflicts.some((c) => c.d >= w.from && c.d <= w.to));
    const again = L.mergeSeries(await fetchAll(redo));
    conflicts = conflicts.flatMap((c) => {
      const ok = again.rows.find((p) => p.d === c.d);
      if (ok) { rows.set(c.d, ok.v); return []; }
      return [again.conflicts.find((x) => x.d === c.d) ?? c];   // 다시 받아도 다르거나 빠짐 → 충돌 유지
    });
  }
  return { rows: [...rows.entries()].map(([d, v]) => ({ d, v })), conflicts };
}

// ── 작업 처리 ────────────────────────────────────────

type Ctx = { job: string; d: string; now: Date; from?: string; stats: Record<string, number>; errors: string[] };

async function handleSeries(t: Task, ctx: Ctx): Promise<Outcome> {
  const s = SERIES[t.symbol];
  if (!s) return ["failed", "알 수 없는 시리즈"];
  const r = await collectSeries(s.code, s.market, ctx.now, ctx.from);
  const res = await rpc("tikr_collect_ingest", {
    p: { series: r.rows.map((p) => [s.code, p.d, p.v]), conflicts: r.conflicts.map((c) => ({ code: s.code, d: c.d, vals: c.vals })) },
  });
  ctx.stats.series += res.series ?? 0;
  ctx.stats.conflicts += r.conflicts.length;
  return ["done", `${r.rows.length}일${r.conflicts.length ? ` · 충돌 ${r.conflicts.length}` : ""}`];
}

// full = 전체 수집 시작일: DB가 그 구간의 저장 날짜를 이번 응답이 모두 덮는지 확인하고 한 번에 교체한다.
async function ingestPx(market: L.Market, symbol: string, bars: L.Bar[],
                        opt: { full?: string; extra?: Record<string, unknown> } = {}) {
  return await rpc("tikr_collect_ingest", {
    p: {
      px: bars.map((b) => [market, symbol, b.d, b.close, b.volume, b.amount]),
      ...(opt.full ? { px_full: true, px_from: opt.full } : {}),
      ...(opt.extra ?? {}),
    },
  });
}

async function handlePx(t: Task, ctx: Ctx): Promise<Outcome> {
  if (t.symbol.startsWith("#")) return await handleSeries(t, ctx);
  // 전체 수집: 백필·수정주가 변경·새 종목(저장 이력 없음)·긴 공백(매일 받는 최근 구간 약 120일로 못 메움)
  const full = t.note === "full" || ctx.job === "backfill" || !t.last_d || t.last_d < L.addDays(ctx.d, -110);
  const today = L.zoned(ctx.now, t.market === "US" ? "America/New_York" : "Asia/Seoul").date;
  const fullFrom = ctx.from ?? L.addDays(today, -HISTORY_DAYS);
  const fetchBars = async (all: boolean, excd: string | null) =>
    L.dropIncomplete(
      t.market === "US"
        ? await usDaily(excd!, t.symbol, all ? fullFrom : null)
        : await krDaily(t.symbol, all ? fullFrom : L.addDays(ctx.d, -120), today),
      ctx.now, t.market);

  let excd = t.excd;
  let bars: L.Bar[] = [];
  const extra: Record<string, unknown> = {};
  if (t.market === "US" && !excd) {   // 거래소 코드 모름 → NAS·NYS·AMS 순서로 찾아 저장
    for (const x of ["NAS", "NYS", "AMS"]) {
      bars = await fetchBars(full, x);
      if (bars.length) { excd = x; extra.symbols = [{ market: "US", symbol: t.symbol, excd: x }]; break; }
    }
    if (!excd) return ["failed", "KIS 시세 없음(거래소 코드 확인 필요)"];
  } else {
    bars = await fetchBars(full, excd);
  }
  if (!bars.length) return ["retry", "시세 없음"];
  if (!full) bars = L.recentForIngest(bars, t.last_d);
  const res = await ingestPx(t.market, t.symbol, bars, { full: full ? fullFrom : undefined, extra });
  ctx.stats.px += res.px ?? 0;
  if ((res.incomplete ?? []).length > 0) return ["retry", "전체 수집이 저장 구간을 다 덮지 못함"];
  if (!full && (res.adjusted ?? []).length > 0) {
    // 저장된 과거 종가가 바뀜(액면분할 등) → DB는 아무것도 쓰지 않았다. 전체를 받아 한 번에 교체
    // (실패해도 다음 시도가 다시 감지한다).
    const all = await fetchBars(true, excd);
    const r2 = await ingestPx(t.market, t.symbol, all, { full: fullFrom });
    if ((r2.incomplete ?? []).length > 0) return ["retry", "수정주가 변경 · 전체 재수집 불완전"];
    ctx.stats.px += r2.px ?? 0;
    ctx.stats.adjusted += 1;
    return ["done", `수정주가 변경 → 전체 재수집 ${all.length}일`];
  }
  return ["done", null];
}

async function handleCheck(t: Task, ctx: Ctx): Promise<Outcome> {
  if (!(typeof t.close === "number" && t.close > 0)) return ["done", "당일 봉 없음"];
  const q = await fhGet("/quote", { symbol: t.symbol });
  const ref = L.finnhubSameDay(q, ctx.d);
  if (!ref) { ctx.stats.unchecked += 1; return ["done", "같은 거래일 Finnhub 값 없음 → 비교 보류"]; }
  const cmp = L.price2Source(t.close, ref.price);
  if (cmp.ok) { ctx.stats.matched += 1; return ["done", null]; }
  ctx.stats.mismatched += 1;
  await rpc("tikr_collect_ingest", {
    p: { holds: [["US", t.symbol, ctx.d, "가격 불일치", { kis: t.close, finnhub: ref.price, field: ref.field, diff: cmp.diff }]] },
  });
  return ["done", `가격 불일치 ${(cmp.diff * 100).toFixed(2)}%`];
}

async function handleFund(t: Task, ctx: Ctx): Promise<Outcome> {
  if (t.market === "US") {
    const metric = await fhGet("/stock/metric", { symbol: t.symbol, metric: "all" });
    let currency = t.currency;
    const extra: Record<string, unknown> = {};
    const stale = !t.currency_at || Date.parse(t.currency_at) < ctx.now.getTime() - CURRENCY_TTL_DAYS * 86_400_000;
    if (!currency || stale) {
      const prof = await fhGet("/stock/profile2", { symbol: t.symbol });
      currency = typeof prof?.currency === "string" && prof.currency ? prof.currency : null;
      extra.symbols = [{ market: "US", symbol: t.symbol, currency }];
    }
    let tomv: unknown = null, tomvCur: string | null = null;
    if (currency && currency !== "USD" && t.excd) {   // 비USD 보고(ADR)만 KIS 상장 주식 기준 시총으로 대체
      const o = (await kisGet("/uapi/overseas-price/v1/quotations/price-detail", "HHDFS76200200",
        { AUTH: "", EXCD: t.excd, SYMB: L.kisUsSymbol(t.symbol) })).output ?? {};
      tomv = o.tomv; tomvCur = typeof o.curr === "string" ? o.curr : null;
    }
    await rpc("tikr_collect_ingest", { p: { fund: [L.usFund(t.symbol, ctx.d, metric, currency, tomv, tomvCur)], ...extra } });
  } else {
    const price = (await kisGet("/uapi/domestic-stock/v1/quotations/inquire-price", "FHKST01010100",
      { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: t.symbol })).output ?? {};
    const ratio = (await kisGet("/uapi/domestic-stock/v1/finance/financial-ratio", "FHKST66430300",
      { FID_DIV_CLS_CODE: "1", fid_cond_mrkt_div_code: "J", fid_input_iscd: t.symbol })).output;
    await rpc("tikr_collect_ingest", { p: { fund: [L.krFund(t.symbol, ctx.d, price, ratio)] } });
  }
  ctx.stats.fund += 1;
  return ["done", null];
}

// 한 단계(작업 종류)를 시간이 허락하는 만큼 처리. 남은 작업이 없으면 true(다른 호출이 처리 중이면 false).
async function runPhase(job: string, d: string, ctx: Ctx, handle: (t: Task, c: Ctx) => Promise<Outcome>,
                        timeLeft: () => number): Promise<boolean> {
  const c = { ...ctx, job, d };
  while (timeLeft() > 20_000) {
    const r = await rpc("tikr_collect_lease", { p_job: job, p_d: d, p_limit: LEASE });
    const tasks: Task[] = r.tasks ?? [];
    if (tasks.length === 0) return (r.remaining ?? 0) === 0;
    const done: unknown[] = [];
    for (const t of tasks) {
      if (timeLeft() < 12_000) { done.push([job, d, t.market, t.symbol, "release", null]); continue; }
      let out: Outcome;
      try {
        out = await handle(t, c);
      } catch (e) {
        const msg = L.maskSecrets(String((e as Error).message ?? e)).slice(0, 200);
        if (ctx.errors.length < 5) ctx.errors.push(`${job} ${t.symbol}: ${msg}`);
        out = [t.tries >= 3 ? "failed" : "retry", msg];
      }
      if (out[0] === "failed") ctx.stats.failed += 1;
      done.push([job, d, t.market, t.symbol, ...out]);
    }
    await rpc("tikr_collect_ingest", { p: { done } });
  }
  return false;
}

Deno.serve(async (req) => {
  // 크론(service_role)만 호출 — 앱 키로 부르면 KIS·Finnhub 호출 한도를 소모시킬 수 있다.
  // 서명은 게이트웨이(verify_jwt 기본값 — --no-verify-jwt로 배포 금지)가 검증하고 여기선 역할만 본다.
  // 크론에 저장된 service_role JWT는 함수 환경변수의 키와 글자가 다를 수 있다(2026-09-30 실측: 문자열 비교로 403).
  if (L.bearerRole(req.headers.get("Authorization")) !== "service_role") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const t0 = Date.now();
  const timeLeft = () => BUDGET_MS - (Date.now() - t0);
  const body = await req.json().catch(() => ({}));
  const job = String(body.job ?? "");
  const now = new Date();
  const stats: Record<string, number> = {
    px: 0, series: 0, conflicts: 0, adjusted: 0, fund: 0, matched: 0, mismatched: 0, unchecked: 0, failed: 0, confirmed: 0,
  };
  const ctx: Ctx = { job, d: "", now, stats, errors: [] };
  let confirm: unknown = null;
  let d = "";

  try {
    if (job === "kr") {
      d = L.lastSession(now, "KR");
      await runPhase("kr_px", d, ctx, handlePx, timeLeft);
    } else if (job === "us") {
      d = L.lastSession(now, "US");
      // 전날 저녁 한국 수집이 덜 끝났거나 아예 안 돌았으면 여기서 마저(같은 평가일일 때만)
      const krDone = L.lastSession(now, "KR") !== d || await runPhase("kr_px", d, ctx, handlePx, timeLeft);
      if (krDone && await runPhase("us_px", d, ctx, handlePx, timeLeft) &&
          await runPhase("us_check", d, ctx, handleCheck, timeLeft)) {
        // 한 번에 4건(시장·날짜)씩 — 요청 제한(8초) 안에서. 남으면 이어서 부른다.
        do {
          confirm = await rpc("tikr_collect_confirm", { p_d: d });
          stats.confirmed += (confirm as any)?.rows ?? 0;
        } while ((confirm as any)?.status === "partial" && timeLeft() > 20_000);
        const miss = (confirm as any)?.missing as [string, string][] | undefined;
        if (miss?.length) {
          // 종목은 거래했는데 지수 값이 빠진 날(그 시장·날짜만 확정 보류됨) → 지수 작업을 다시 열어 재수집(3분·6분 뒤, 최대 3회)
          const done = [...new Set(miss.map(([code]) => code))].map((code) =>
            [code === "COMP" ? "us_px" : "kr_px", d, code === "COMP" ? "US" : "KR", `#${code}`, "retry", "지수 누락 재수집"]);
          await rpc("tikr_collect_ingest", { p: { done } });
        }
      }
    } else if (job === "fund") {
      d = L.lastSession(now, "US");
      await runPhase("fund", d, ctx, handleFund, timeLeft);
    } else if (job === "backfill") {
      const from = String(body.from ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return Response.json({ error: "from(YYYY-MM-DD) 필요" }, { status: 400 });
      d = from;
      ctx.from = from;
      if (body.plan) stats.planned = await rpc("tikr_collect_plan", { p_job: "backfill", p_d: from, p_items: body.items ?? null });
      await runPhase("backfill", from, ctx, handlePx, timeLeft);
    } else {
      return Response.json({ error: "job은 kr·us·fund·backfill 중 하나" }, { status: 400 });
    }
  } catch (e) {
    ctx.errors.push(L.maskSecrets(String((e as Error).message ?? e)).slice(0, 200));
  }

  const summary = { job, d, ms: Date.now() - t0, ...stats, confirm, errors: ctx.errors };
  const busy = Object.values(stats).some((v) => v > 0) || ctx.errors.length > 0 ||
    ((confirm as any)?.rows ?? 0) > 0 || ((confirm as any)?.status && (confirm as any).status !== "confirmed");
  if (busy) await rpc("tikr_collect_ingest", { p: { log: { job, d, summary } } }).catch(() => {});
  return Response.json(summary);
});
