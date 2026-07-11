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

// 캔들차트 1일/1주용 "장중(분·시간)봉" on-demand 조회. DB에 저장하지 않고 매 요청마다 소스에서 바로 받아 반환.
// 토스처럼 1일=분봉, 1주=시간봉으로 캔들이 빽빽하게 나오게 하는 용도.
//  · 미국: 야후 파이낸스 차트 API 분봉(무인증·무제한, 1일=5분/1주=30분)
//  · 한국: KIS 분봉(inquire-time-itemchartprice). 당일 분봉만 제공돼서 1일만 지원, 1주는 daily 폴백 신호 반환

// ── 야후(미국) 분봉 ──
async function fetchYahooIntraday(symbol: string, period: string) {
  const interval = period === "1W" ? "30m" : "5m";
  const range = period === "1W" ? "5d" : "1d";
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`);
  url.searchParams.set("interval", interval);
  url.searchParams.set("range", range);
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`yahoo ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const result = body.chart?.result?.[0];
  if (!result) throw new Error("yahoo: 데이터 없음");
  const ts: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const rows = ts
    .map((t, i) => ({
      t: new Date(t * 1000).toISOString(),
      open: q.open?.[i], high: q.high?.[i], low: q.low?.[i], close: q.close?.[i], volume: q.volume?.[i],
    }))
    .filter((r) => r.close != null && r.open != null);
  return rows;
}

// ── KIS(한국) 분봉 ── 당일 1분봉. 1회 호출당 최대 30건 반환 → 기준시각을 뒤로 옮겨가며 장 시작까지 이어붙임.
async function getKisToken(): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/kis-auth`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`kis-auth 실패 (${res.status}): ${await res.text()}`);
  return (await res.json()).access_token;
}

async function fetchKisMinuteChunk(token: string, code: string, hhmmss: string) {
  const url = new URL(`${KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice`);
  url.searchParams.set("FID_ETC_CLS_CODE", "");
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
  url.searchParams.set("FID_INPUT_ISCD", code);
  url.searchParams.set("FID_INPUT_HOUR_1", hhmmss);
  url.searchParams.set("FID_PW_DATA_INCU_YN", "Y");
  const res = await fetch(url, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      appkey: KIS_APP_KEY,
      appsecret: KIS_APP_SECRET,
      tr_id: "FHKST03010200",
      custtype: "P",
    },
  });
  const body = await res.json();
  if (!res.ok || body.rt_cd !== "0") throw new Error(`KIS 분봉 실패(${hhmmss}): ${JSON.stringify(body)}`);
  return body.output2 ?? [];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchKisIntraday(code: string) {
  const token = await getKisToken();
  const seen = new Set<string>();
  const all: any[] = [];
  let hour = "153000"; // 장 마감(15:30)부터 뒤로
  for (let call = 0; call < 14; call++) {
    let chunk: any[];
    try {
      chunk = await fetchKisMinuteChunk(token, code, hour);
    } catch (_e) {
      break; // 실패하면 지금까지 모은 것만 반환
    }
    if (!chunk.length) break;
    let earliest = hour;
    for (const r of chunk) {
      const key = r.stck_cntg_hour;
      if (key && !seen.has(key)) { seen.add(key); all.push(r); }
      if (key && key < earliest) earliest = key;
    }
    if (earliest <= "090000" || earliest === hour) break;
    // 다음 호출은 이번에 받은 가장 이른 시각 직전부터
    hour = String(Math.max(90000, parseInt(earliest, 10) - 100)).padStart(6, "0");
    await sleep(500); // KIS 초당 거래건수 제한 회피
  }
  // 시간순 정렬(과거→최신)
  all.sort((a, b) => a.stck_cntg_hour.localeCompare(b.stck_cntg_hour));
  const today = all[0]?.stck_bsop_date; // YYYYMMDD
  return all.map((r) => {
    const h = r.stck_cntg_hour; // HHMMSS
    const iso = today
      ? `${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6, 8)}T${h.slice(0, 2)}:${h.slice(2, 4)}:${h.slice(4, 6)}+09:00`
      : new Date().toISOString();
    return {
      t: new Date(iso).toISOString(),
      open: parseFloat(r.stck_oprc ?? "0"),
      high: parseFloat(r.stck_hgpr ?? "0"),
      low: parseFloat(r.stck_lwpr ?? "0"),
      close: parseFloat(r.stck_prpr ?? "0"),
      volume: parseFloat(r.cntg_vol ?? "0") || null,
    };
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const { symbol, period } = await req.json().catch(() => ({}));
  if (!symbol) return Response.json({ error: "symbol 필요" }, { status: 400, headers: CORS_HEADERS });
  const isKR = /\.(KS|KQ)$/.test(symbol);

  try {
    if (isKR) {
      // KIS 분봉은 당일만 → 1주는 일봉으로 폴백하라고 프론트에 신호
      if (period === "1W") return Response.json({ fallback: "daily" }, { headers: CORS_HEADERS });
      const rows = await fetchKisIntraday(symbol.split(".")[0]);
      if (!rows.length) return Response.json({ fallback: "daily" }, { headers: CORS_HEADERS });
      return Response.json({ rows, source: "kis" }, { headers: CORS_HEADERS });
    }
    const rows = await fetchYahooIntraday(symbol, period);
    if (!rows.length) return Response.json({ fallback: "daily" }, { headers: CORS_HEADERS });
    return Response.json({ rows, source: "yahoo" }, { headers: CORS_HEADERS });
  } catch (e) {
    return Response.json({ error: (e as Error).message, fallback: "daily" }, { status: 200, headers: CORS_HEADERS });
  }
});
