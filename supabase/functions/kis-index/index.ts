import { createClient } from "jsr:@supabase/supabase-js@2";

const KIS_BASE_URL = Deno.env.get("KIS_BASE_URL") ?? "https://openapi.koreainvestment.com:9443";
const KIS_APP_KEY = Deno.env.get("KIS_APP_KEY")!;
const KIS_APP_SECRET = Deno.env.get("KIS_APP_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// 코스피(0001)·코스닥(1001) 지수 현재가 조회 — kis-auth로 캐시된 토큰 재사용
const INDEXES: Record<string, string> = { "0001": "KOSPI", "1001": "KOSDAQ" };

async function getToken(): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/kis-auth`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`kis-auth 호출 실패 (${res.status}): ${await res.text()}`);
  const body = await res.json();
  return body.access_token;
}

async function fetchIndex(token: string, code: string) {
  const url = new URL(`${KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-index-price`);
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "U");
  url.searchParams.set("FID_INPUT_ISCD", code);

  const res = await fetch(url, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      appkey: KIS_APP_KEY,
      appsecret: KIS_APP_SECRET,
      tr_id: "FHPUP02100000",
      custtype: "P",
    },
  });
  if (!res.ok) throw new Error(`KIS 지수 조회 실패 (${code}, ${res.status}): ${await res.text()}`);
  return await res.json();
}

Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const token = await getToken();

  const results = [];
  let first = true;
  for (const [code, name] of Object.entries(INDEXES)) {
    if (!first) await new Promise((r) => setTimeout(r, 1100)); // KIS 초당 거래건수 제한 회피
    first = false;
    try {
      const data = await fetchIndex(token, code);
      const out = data.output ?? {};
      // prdy_vrss_sign: 1=상한 2=상승 3=보합 4=하한 5=하락 (KIS 공통 부호코드) — 하락일 땐 음수로 변환
      const isDown = out.prdy_vrss_sign === "4" || out.prdy_vrss_sign === "5";
      const rawChange = Math.abs(parseFloat(out.bstp_nmix_prdy_vrss ?? "0"));
      const rawPct = Math.abs(parseFloat(out.bstp_nmix_prdy_ctrt ?? "0"));
      results.push({
        symbol: name,
        price: parseFloat(out.bstp_nmix_prpr ?? out.bstp_nmix_pric ?? "0"),
        change: isDown ? -rawChange : rawChange,
        percent_change: isDown ? -rawPct : rawPct,
        fetched_at: new Date().toISOString(),
      });
    } catch (e) {
      results.push({ symbol: name, error: (e as Error).message });
    }
  }

  const ok = results.filter((r) => !("error" in r));
  if (ok.length > 0) {
    await supabase.from("quote_history").insert(
      ok.map((r: any) => ({
        symbol: r.symbol,
        price: r.price,
        change: r.change,
        percent_change: r.percent_change,
        fetched_at: r.fetched_at,
      })),
    );
  }

  return Response.json({ results });
});
