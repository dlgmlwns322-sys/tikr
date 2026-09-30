import { createClient } from "jsr:@supabase/supabase-js@2";
import * as L from "./logic.ts";

// 티커 앱 v9 보조 수집 — VIX(FRED VIXCLS)·종목 한글 이름(KIS 상품 정보). 규칙: 볼트 「앱_v9_구현」.
//   · 크론(service_role)만 호출. DB는 public.tikr_extra_state(할 일 조회)·tikr_extra_ingest(넣기)만 쓴다.
//   · 전송량: DB에서 읽는 건 할 일 목록(최대 60종목)뿐. 외부 API 응답은 전송량에 안 잡힌다.
// 요청 body.job
//   daily  하루 1회: VIX(마지막 저장일 10일 전부터, 처음이면 400일) → 이름 없는 종목 이름 채우기(시간 안에서 반복)
//   vix    VIX만
//   names  이름만

const KIS = Deno.env.get("KIS_BASE_URL") ?? "https://openapi.koreainvestment.com:9443";
const KIS_APP_KEY = Deno.env.get("KIS_APP_KEY")!;
const KIS_APP_SECRET = Deno.env.get("KIS_APP_SECRET")!;
const FRED_API_KEY = Deno.env.get("FRED_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const BUDGET_MS = 110_000;   // 벽시계 150초 제한 안에서 여유
const KIS_GAP_MS = 250;      // KIS 초당 거래건수 — 다른 함수 몫을 남기고 초당 4건

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastKis = 0;

async function rpc(name: string, args: Record<string, unknown> = {}) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

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

// KIS GET: 초당 거래건수 초과(EGW00201)·서버 오류만 1·2초 뒤 재시도. 조회 결과 없음은 null.
async function kisGet(path: string, trId: string, params: Record<string, string>): Promise<any | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = lastKis + KIS_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastKis = Date.now();
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
    if (body?.msg_cd !== "EGW00201" && res.status < 500) return null;   // 없는 종목 등 — 다음 후보로
    await sleep(1_000 * (attempt + 1));
  }
  throw new Error(`KIS ${trId} 재시도 초과`);
}

async function usName(symbol: string, excd: string | null): Promise<string | null> {
  const pdno = symbol.replace(".", "/");   // 클래스 주식 코드(BRK.B → BRK/B), 수집기와 같은 규칙
  for (const code of L.usTypeCodes(excd)) {
    const body = await kisGet("/uapi/overseas-price/v1/quotations/search-info", "CTPF1702R",
      { PRDT_TYPE_CD: code, PDNO: pdno });
    const name = L.pickName(body?.output, "US");
    if (name) return name;
  }
  return null;
}

async function krName(symbol: string): Promise<string | null> {
  const body = await kisGet("/uapi/domestic-stock/v1/quotations/search-stock-info", "CTPF1002R",
    { PRDT_TYPE_CD: "300", PDNO: symbol });
  return L.pickName(body?.output, "KR");
}

async function doVix(stats: Record<string, number>) {
  const state = await rpc("tikr_extra_state");
  const today = new Date().toISOString().slice(0, 10);
  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", "VIXCLS");
  url.searchParams.set("file_type", "json");
  url.searchParams.set("observation_start", L.vixStart(state?.vix_last ?? null, today));
  url.searchParams.set("api_key", FRED_API_KEY);
  const res = await fetch(url);
  if (!res.ok) { await res.body?.cancel(); throw new Error(`FRED VIXCLS ${res.status}`); }   // URL엔 키가 있어 싣지 않음
  const rows = L.parseFred(await res.json());
  if (rows.length) stats.vix = (await rpc("tikr_extra_ingest", { p: { macro: rows } }))?.macro ?? 0;
}

async function doNames(stats: Record<string, number>, timeLeft: () => number) {
  // 커서('시장:코드')로 페이지를 넘긴다 — 이름을 못 찾은 종목은 뒤로 지나가고, 다음 날 다시 시도된다.
  let after: string | null = null;
  while (timeLeft() > 20_000) {
    const state = await rpc("tikr_extra_state", { p_after: after });
    const todo = (state?.names_missing ?? []) as { market: "US" | "KR"; symbol: string; excd: string | null; key: string }[];
    if (todo.length === 0) return;
    const names: [string, string, string][] = [];
    let done = 0;
    for (const t of todo) {
      if (timeLeft() < 12_000) break;
      const name = t.market === "US" ? await usName(t.symbol, t.excd) : await krName(t.symbol);
      if (name) names.push([t.market, t.symbol, name]);
      else stats.names_missing = (stats.names_missing ?? 0) + 1;
      after = t.key;
      done++;
    }
    if (names.length) stats.names = (stats.names ?? 0) + ((await rpc("tikr_extra_ingest", { p: { names } }))?.names ?? 0);
    if (done < todo.length) return;   // 시간 부족 — 다음 호출이 잇는다
  }
}

Deno.serve(async (req) => {
  // 크론(service_role)만 — 앱 키로 부르면 KIS·FRED 호출 한도를 소모시킬 수 있다.
  if (L.bearerRole(req.headers.get("Authorization")) !== "service_role") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const t0 = Date.now();
  const timeLeft = () => BUDGET_MS - (Date.now() - t0);
  const body = await req.json().catch(() => ({}));
  const job = String(body.job ?? "");
  if (!["daily", "vix", "names"].includes(job)) {
    return Response.json({ error: "job은 daily·vix·names 중 하나" }, { status: 400 });
  }
  const stats: Record<string, number> = {};
  const errors: string[] = [];
  if (job === "daily" || job === "vix") {
    try { await doVix(stats); } catch (e) { errors.push(L.maskSecrets(String((e as Error).message ?? e)).slice(0, 200)); }
  }
  if (job === "daily" || job === "names") {
    try { await doNames(stats, timeLeft); } catch (e) { errors.push(L.maskSecrets(String((e as Error).message ?? e)).slice(0, 200)); }
  }
  return Response.json({ job, ms: Date.now() - t0, ...stats, errors });
});
