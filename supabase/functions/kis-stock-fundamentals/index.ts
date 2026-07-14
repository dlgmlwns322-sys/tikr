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

// 한국 개별종목 밸류에이션(PER/PBR/EPS/BPS/52주최고저/시가총액) — 종목상세에서 심볼 하나만 온디맨드 조회.
// kis-stock-quote(전체 워치리스트 폴링)가 이미 매번 호출하는 inquire-price와 동일 엔드포인트지만,
// 그 응답에 이 필드들이 원래 다 포함돼 있는데도 안 쓰고 버리고 있었음 — 신규 API 호출 아님, 파싱만 추가.
async function getToken(): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/kis-auth`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`kis-auth 호출 실패 (${res.status}): ${await res.text()}`);
  const body = await res.json();
  return body.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const { symbol } = await req.json().catch(() => ({}));
  if (!symbol) return Response.json({ error: "symbol 필요" }, { status: 400, headers: CORS_HEADERS });

  const code = symbol.split(".")[0];
  try {
    const token = await getToken();
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
      throw new Error(`밸류에이션 조회 실패 (${symbol}, ${res.status}): ${JSON.stringify(body)}`);
    }
    const o = body.output ?? {};
    const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : parseFloat(v as string));
    return Response.json({
      symbol,
      per: num(o.per),
      pbr: num(o.pbr),
      eps: num(o.eps),
      bps: num(o.bps),
      week52High: num(o.w52_hgpr),
      week52Low: num(o.w52_lwpr),
      marketCapEok: num(o.hts_avls), // 억원 단위
    }, { headers: CORS_HEADERS });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500, headers: CORS_HEADERS });
  }
});
