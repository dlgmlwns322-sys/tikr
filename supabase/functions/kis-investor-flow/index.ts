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

// 한국 개별종목 외국인/기관 순매수 — 종목상세에서 심볼 하나만 온디맨드 조회(DB 저장 없음, 컨센서스·실적일정과 동일 패턴).
// KIS inquire-investor(tr_id FHKST01010900)가 최근 약 30거래일치를 한 번에 반환.
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
    const url = new URL(`${KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-investor`);
    url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
    url.searchParams.set("FID_INPUT_ISCD", code);
    const res = await fetch(url, {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        appkey: KIS_APP_KEY,
        appsecret: KIS_APP_SECRET,
        tr_id: "FHKST01010900",
        custtype: "P",
      },
    });
    const body = await res.json();
    if (!res.ok || body.rt_cd !== "0") {
      throw new Error(`투자자별 매매동향 조회 실패 (${symbol}, ${res.status}): ${JSON.stringify(body)}`);
    }
    const output = (body.output ?? []) as Record<string, string>[];
    // 당일 장중엔 값이 전부 빈 문자열로 옴 — 그 행은 제외하고 확정된 과거 거래일만
    const rows = output
      .filter((r) => r.frgn_ntby_qty !== "")
      .slice(0, 10)
      .map((r) => ({
        date: r.stck_bsop_date, // YYYYMMDD
        individual: parseFloat(r.prsn_ntby_qty || "0"),
        foreign: parseFloat(r.frgn_ntby_qty || "0"),
        institution: parseFloat(r.orgn_ntby_qty || "0"),
      }))
      .reverse(); // 오래된 날짜 → 최신 순으로
    return Response.json({ symbol, rows }, { headers: CORS_HEADERS });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500, headers: CORS_HEADERS });
  }
});
