import { createClient } from "jsr:@supabase/supabase-js@2";

const KIS_BASE_URL = Deno.env.get("KIS_BASE_URL") ?? "https://openapi.koreainvestment.com:9443";
const KIS_APP_KEY = Deno.env.get("KIS_APP_KEY")!;
const KIS_APP_SECRET = Deno.env.get("KIS_APP_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 코스피/코스닥 개별 종목의 과거 일별 시세를 채워넣는 백필용 함수(1회성 호출 용도).
// 사용자가 앱 쓰기 전 과거 데이터도 차트에서 보고 싶다고 요청 — Finnhub 미국 캔들은 무료로 막혀있지만
// KIS는 국내 종목 기간별시세를 무료로 제공해서 이걸로 채운다.
async function getToken(): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/kis-auth`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`kis-auth 호출 실패 (${res.status}): ${await res.text()}`);
  const body = await res.json();
  return body.access_token;
}

function isoCompact(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

async function fetchChunk(token: string, code: string, from: Date, to: Date) {
  const url = new URL(`${KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`);
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
  url.searchParams.set("FID_INPUT_ISCD", code);
  url.searchParams.set("FID_INPUT_DATE_1", isoCompact(from));
  url.searchParams.set("FID_INPUT_DATE_2", isoCompact(to));
  url.searchParams.set("FID_PERIOD_DIV_CODE", "D");
  url.searchParams.set("FID_ORG_ADJ_PRC", "0");

  const res = await fetch(url, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      appkey: KIS_APP_KEY,
      appsecret: KIS_APP_SECRET,
      tr_id: "FHKST03010100",
      custtype: "P",
    },
  });
  const body = await res.json();
  if (!res.ok || body.rt_cd !== "0") {
    throw new Error(`과거시세 조회 실패(${isoCompact(from)}~${isoCompact(to)}): ${JSON.stringify(body)}`);
  }
  return body.output2 ?? [];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const { symbol, days } = await req.json().catch(() => ({}));
  if (!symbol) {
    return Response.json({ error: "symbol is required (예: 000660.KS)" }, { status: 400, headers: CORS_HEADERS });
  }
  const code = symbol.split(".")[0];

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const token = await getToken();

  // KIS 기간별시세는 요청 구간 폭과 무관하게 1회 호출당 최대 100건만 반환함(실측 확인됨).
  // 100일 단위로 구간을 쪼개 여러 번 호출해서 이어붙이는 방식으로 우회.
  const totalDays = days ?? 365;
  const CHUNK_DAYS = 100;
  const to = new Date();
  const allRows: any[] = [];
  const seenDates = new Set<string>();

  let chunkEnd = to;
  let remaining = totalDays;
  while (remaining > 0) {
    const span = Math.min(CHUNK_DAYS, remaining);
    const chunkStart = new Date(chunkEnd.getTime() - span * 24 * 60 * 60 * 1000);
    const rows = await fetchChunk(token, code, chunkStart, chunkEnd);
    for (const r of rows) {
      if (!seenDates.has(r.stck_bsop_date)) {
        seenDates.add(r.stck_bsop_date);
        allRows.push(r);
      }
    }
    remaining -= span;
    chunkEnd = new Date(chunkStart.getTime() - 24 * 60 * 60 * 1000);
    if (remaining > 0) await sleep(1100); // KIS 초당 거래건수 제한 회피
  }

  // 날짜순 정렬(과거→최신) 후 전일 대비 등락 직접 계산 (KIS 일별차트 응답엔 전일대비가 없는 경우가 있어 안전하게 직접 산출)
  const sorted = allRows.slice().sort((a: any, b: any) => a.stck_bsop_date.localeCompare(b.stck_bsop_date));
  const inserts = [];
  const ohlcRows = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = parseFloat(sorted[i].stck_clpr ?? "0");
    const prev = i > 0 ? parseFloat(sorted[i - 1].stck_clpr ?? "0") : null;
    const change = prev ? cur - prev : null;
    const percentChange = prev ? (change! / prev) * 100 : null;
    const d = sorted[i].stck_bsop_date; // YYYYMMDD
    const isoDate = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T06:00:00.000Z`; // 한국 장마감(15:30 KST)쯤을 UTC로 대략 표기
    inserts.push({ symbol, price: cur, change, percent_change: percentChange, fetched_at: isoDate });
    // KIS 일별차트 응답: stck_oprc(시가)/stck_hgpr(고가)/stck_lwpr(저가)/stck_clpr(종가)/acml_vol(거래량)
    ohlcRows.push({
      symbol,
      date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
      open: parseFloat(sorted[i].stck_oprc ?? "0") || cur,
      high: parseFloat(sorted[i].stck_hgpr ?? "0") || cur,
      low: parseFloat(sorted[i].stck_lwpr ?? "0") || cur,
      close: cur,
      volume: parseFloat(sorted[i].acml_vol ?? "0") || null,
      percent_change: percentChange,
    });
  }

  if (inserts.length > 0) {
    // 재백필 시 중복 삽입 방지 (symbol+fetched_at 유니크 제약이 없어서 겹치는 날짜만 정확히 지우고 다시 채움).
    // 실시간 폴링(kis-stock-quote) 데이터가 섞이지 않도록, 폭넓은 range delete 대신 백필 대상 날짜의 정확한 타임스탬프만 지운다.
    const exactTimestamps = inserts.map((i) => i.fetched_at);
    await supabase.from("quote_history").delete().eq("symbol", symbol).in("fetched_at", exactTimestamps);
    await supabase.from("quote_history").insert(inserts);
    // 캔들차트용 일봉 OHLCV — (symbol, date) 기준 upsert
    await supabase.from("daily_ohlc").upsert(ohlcRows, { onConflict: "symbol,date" });
  }

  const from = new Date(to.getTime() - totalDays * 24 * 60 * 60 * 1000);
  return Response.json({ inserted: inserts.length, range: { from: isoCompact(from), to: isoCompact(to) } }, { headers: CORS_HEADERS });
});
