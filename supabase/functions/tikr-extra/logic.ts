// tikr-extra 순수 규칙 — 외부 호출·DB 없이 시험 가능(test/tikr-extra.test.mjs).

// ── 호출 권한(tikr-collect와 같은 규칙) ─────────────────
// Authorization Bearer JWT의 role(서명 검증은 게이트웨이 verify_jwt가 먼저 한다는 전제 — --no-verify-jwt 배포 금지).
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

// 오류 메시지 비밀 가리기(URL의 api_key=·token=)
export function maskSecrets(msg: string): string {
  return msg.replace(/([?&](?:api_key|token)=)[^&\s)"']+/gi, "$1***");
}

// ── 날짜 ─────────────────────────────────────────
export function addDays(d: string, n: number): string {
  const t = new Date(d + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

// VIX 받을 시작일: 저장된 마지막 날짜 10일 전부터(수정·지연 반영), 없으면 오늘 400일 전부터
export function vixStart(last: string | null, today: string): string {
  return last && /^\d{4}-\d{2}-\d{2}$/.test(last) ? addDays(last, -10) : addDays(today, -400);
}

// FRED observations → [["VIX", date, value]] (값 "."·비숫자·0 이하는 버림)
export function parseFred(body: unknown): [string, string, number][] {
  const obs = (body as { observations?: unknown })?.observations;
  if (!Array.isArray(obs)) return [];
  const out: [string, string, number][] = [];
  for (const o of obs) {
    const d = (o as { date?: unknown })?.date;
    const v = (o as { value?: unknown })?.value;
    if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (typeof v !== "string" || !/^[0-9]+(\.[0-9]+)?$/.test(v)) continue;
    const x = Number(v);
    if (!(x > 0) || !Number.isFinite(x)) continue;
    out.push(["VIX", d, x]);
  }
  return out;
}

// ── 종목 이름(KIS 상품 정보) ─────────────────────────
// 미국: 해외주식 상품기본정보 CTPF1702R — PRDT_TYPE_CD 512 나스닥 · 513 뉴욕 · 529 아멕스.
// 거래소를 모르면 세 곳을 차례로 시도한다.
export function usTypeCodes(excd: string | null): string[] {
  const m: Record<string, string> = { NAS: "512", NYS: "513", AMS: "529" };
  const first = excd ? m[excd] : undefined;
  return first ? [first, ...["512", "513", "529"].filter((c) => c !== first)] : ["512", "513", "529"];
}

// 이름 고르기: 한글 이름 우선, 없으면 영문. 공백 정리·60자 제한. 없으면 null.
export function pickName(output: Record<string, unknown> | null | undefined, market: "US" | "KR"): string | null {
  if (!output) return null;
  const keys = market === "KR" ? ["prdt_abrv_name", "prdt_name"] : ["prdt_name", "prdt_eng_name"];
  for (const k of keys) {
    const v = output[k];
    if (typeof v === "string") {
      const s = v.replace(/\s+/g, " ").trim();
      if (s) return s.slice(0, 60);
    }
  }
  return null;
}
