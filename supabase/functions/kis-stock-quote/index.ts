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

// kis-index와 동일한 inquire-price 계열이지만 시장구분코드가 "J"(개별 종목)인 버전.
// watchlist에 코스피/코스닥 개별 종목(예: 000660.KS)이 추가됐을 때 이 함수로 시세를 채운다.
async function getToken(): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/kis-auth`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`kis-auth 호출 실패 (${res.status}): ${await res.text()}`);
  const body = await res.json();
  return body.access_token;
}

async function fetchStockPrice(token: string, code: string) {
  const url = new URL(`${KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-price`);
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
  url.searchParams.set("FID_INPUT_ISCD", code);

  const res = await fetch(url, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      appkey: KIS_APP_KEY,
      appsecret: KIS_APP_SECRET,
      tr_id: "FHKST01010100",
      custtype: "P",
    },
  });
  const body = await res.json();
  if (!res.ok || body.rt_cd !== "0") {
    throw new Error(`개별종목 시세 조회 실패 (${code}, ${res.status}): ${JSON.stringify(body)}`);
  }
  return body.output ?? {};
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // watchlist에서 코스피/코스닥 개별 종목(.KS/.KQ 접미사)만 골라서 조회
  const { data: watchlist, error } = await supabase.from("watchlist").select("symbol");
  if (error) return Response.json({ error: error.message }, { status: 500, headers: CORS_HEADERS });

  const krSymbols = (watchlist ?? []).map((w) => w.symbol).filter((s) => /\.(KS|KQ)$/.test(s));
  if (!krSymbols.length) {
    return Response.json({ quotes: [] }, { headers: CORS_HEADERS });
  }

  const token = await getToken();
  const results = [];
  let first = true;
  for (const symbol of krSymbols) {
    if (!first) await new Promise((r) => setTimeout(r, 1100)); // KIS 초당 거래건수 제한 회피
    first = false;
    const code = symbol.split(".")[0];
    try {
      const out = await fetchStockPrice(token, code);
      const isDown = out.prdy_vrss_sign === "4" || out.prdy_vrss_sign === "5";
      const rawChange = Math.abs(parseFloat(out.prdy_vrss ?? "0"));
      const rawPct = Math.abs(parseFloat(out.prdy_ctrt ?? "0"));
      results.push({
        symbol,
        price: parseFloat(out.stck_prpr ?? "0"),
        change: isDown ? -rawChange : rawChange,
        percent_change: isDown ? -rawPct : rawPct,
        fetched_at: new Date().toISOString(),
      });
    } catch (e) {
      results.push({ symbol, error: (e as Error).message });
    }
  }

  const ok = results.filter((r): r is { symbol: string; price: number; change: number; percent_change: number; fetched_at: string } => !("error" in r));
  if (ok.length > 0) await supabase.from("quote_history").insert(ok);

  return Response.json({ quotes: results }, { headers: CORS_HEADERS });
});
