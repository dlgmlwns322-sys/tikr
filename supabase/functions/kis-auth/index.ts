import { createClient } from "jsr:@supabase/supabase-js@2";

const KIS_BASE_URL = Deno.env.get("KIS_BASE_URL") ?? "https://openapi.koreainvestment.com:9443";
const KIS_APP_KEY = Deno.env.get("KIS_APP_KEY")!;
const KIS_APP_SECRET = Deno.env.get("KIS_APP_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const REFRESH_BUFFER_MS = 10 * 60 * 1000; // KIS 토큰 만료 10분 전 미리 재발급

async function issueToken(): Promise<{ access_token: string; expires_at: string }> {
  const res = await fetch(`${KIS_BASE_URL}/oauth2/tokenP`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: KIS_APP_KEY,
      appsecret: KIS_APP_SECRET,
    }),
  });

  if (!res.ok) {
    throw new Error(`KIS 토큰 발급 실패 (${res.status}): ${await res.text()}`);
  }

  const body = await res.json();
  const expiresAt = new Date(Date.now() + body.expires_in * 1000).toISOString();
  return { access_token: body.access_token, expires_at: expiresAt };
}

Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: cached } = await supabase
    .from("kis_tokens")
    .select("access_token, expires_at")
    .eq("id", 1)
    .maybeSingle();

  if (cached && new Date(cached.expires_at).getTime() - Date.now() > REFRESH_BUFFER_MS) {
    return Response.json({ access_token: cached.access_token, expires_at: cached.expires_at, cached: true });
  }

  const fresh = await issueToken();

  await supabase
    .from("kis_tokens")
    .upsert({ id: 1, access_token: fresh.access_token, expires_at: fresh.expires_at, updated_at: new Date().toISOString() });

  return Response.json({ ...fresh, cached: false });
});
