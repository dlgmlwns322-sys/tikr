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

async function getToken(): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/kis-auth`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`kis-auth 호출 실패 (${res.status}): ${await res.text()}`);
  const body = await res.json();
  return body.access_token;
}

// 국내주식 등락률 순위. sortCls: "0"=상승률 상위, "1"=하락률 상위
async function fetchFluctuationRank(token: string, sortCls: string) {
  const url = new URL(`${KIS_BASE_URL}/uapi/domestic-stock/v1/ranking/fluctuation`);
  url.searchParams.set("fid_cond_mrkt_div_code", "J");
  url.searchParams.set("fid_cond_scr_div_code", "20170");
  url.searchParams.set("fid_input_iscd", "0000");
  url.searchParams.set("fid_rank_sort_cls_code", sortCls);
  url.searchParams.set("fid_input_cnt_1", "0");
  url.searchParams.set("fid_prc_cls_code", "0");
  url.searchParams.set("fid_input_price_1", "");
  url.searchParams.set("fid_input_price_2", "");
  url.searchParams.set("fid_vol_cnt", "");
  url.searchParams.set("fid_trgt_cls_code", "0");
  url.searchParams.set("fid_trgt_exls_cls_code", "0");
  url.searchParams.set("fid_div_cls_code", "0");
  url.searchParams.set("fid_rsfl_rate1", "");
  url.searchParams.set("fid_rsfl_rate2", "");

  const res = await fetch(url, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      appkey: KIS_APP_KEY,
      appsecret: KIS_APP_SECRET,
      tr_id: "FHPST01700000",
      custtype: "P",
    },
  });
  const body = await res.json();
  if (!res.ok || body.rt_cd !== "0") {
    throw new Error(`등락률순위 조회 실패 (${res.status}): ${JSON.stringify(body)}`);
  }
  return body.output ?? [];
}

// 국내주식 거래량 순위 (거래대금 상위)
async function fetchVolumeRank(token: string) {
  const url = new URL(`${KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/volume-rank`);
  url.searchParams.set("fid_cond_mrkt_div_code", "J");
  url.searchParams.set("fid_cond_scr_div_code", "20171");
  url.searchParams.set("fid_input_iscd", "0000");
  url.searchParams.set("fid_div_cls_code", "0");
  url.searchParams.set("fid_blng_cls_code", "0");
  url.searchParams.set("fid_trgt_cls_code", "111111111");
  url.searchParams.set("fid_trgt_exls_cls_code", "000000");
  url.searchParams.set("fid_input_price_1", "");
  url.searchParams.set("fid_input_price_2", "");
  url.searchParams.set("fid_vol_cnt", "");
  url.searchParams.set("fid_input_date_1", "");

  const res = await fetch(url, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      appkey: KIS_APP_KEY,
      appsecret: KIS_APP_SECRET,
      tr_id: "FHPST01710000",
      custtype: "P",
    },
  });
  const body = await res.json();
  if (!res.ok || body.rt_cd !== "0") {
    throw new Error(`거래량순위 조회 실패 (${res.status}): ${JSON.stringify(body)}`);
  }
  return body.output ?? [];
}

// 레버리지·인버스·선물 등 파생 ETN/ETF는 실제 "종목"이 아니라 특정 종목의 배율 베팅 상품이라
// 등락률 순위에서 과도하게 상위를 도배함 — 이름 키워드로 걸러내고 일반 종목만 남긴다.
const NOISE_KEYWORDS = ["레버리지", "인버스", "선물", "ETN", "2X", "액티브", "합성"];
function isRealStock(name: string): boolean {
  return !NOISE_KEYWORDS.some((kw) => name.includes(kw));
}

function mapRow(r: any) {
  return {
    symbol: r.stck_shrn_iscd ?? r.mksc_shrn_iscd ?? null,
    name: r.hts_kor_isnm,
    price: parseFloat(r.stck_prpr ?? "0"),
    percent_change: parseFloat(r.prdy_ctrt ?? "0"),
    volume: parseInt(r.acml_vol ?? "0", 10),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const token = await getToken();
    // KIS 초당 거래건수 제한 회피를 위해 순차 호출 + 딜레이
    const gainers = await fetchFluctuationRank(token, "0");
    await new Promise((r) => setTimeout(r, 1100));
    const losers = await fetchFluctuationRank(token, "1");
    await new Promise((r) => setTimeout(r, 1100));
    const volume = await fetchVolumeRank(token);

    return Response.json({
      top_gainers: gainers.filter((r: any) => isRealStock(r.hts_kor_isnm ?? "")).slice(0, 5).map(mapRow),
      top_losers: losers.filter((r: any) => isRealStock(r.hts_kor_isnm ?? "")).slice(0, 5).map(mapRow),
      top_volume: volume.filter((r: any) => isRealStock(r.hts_kor_isnm ?? "")).slice(0, 5).map(mapRow),
    }, { headers: CORS_HEADERS });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500, headers: CORS_HEADERS });
  }
});
