import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// 일회성 정리용. finnhub-quote가 장 마감 중에도 매분 폴링해서 쌓인 동일가격 중복 row를 지운다.
// 시간순으로 연속된 동일 price row 구간에서 맨 처음 것만 남기고 나머지는 삭제.
Deno.serve(async (req) => {
  const { symbol } = await req.json().catch(() => ({}));
  if (!symbol) return Response.json({ error: "symbol required" }, { status: 400 });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabase
    .from("quote_history")
    .select("id,price,fetched_at")
    .eq("symbol", symbol)
    .order("fetched_at", { ascending: true });
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const rows = data ?? [];
  const idsToDelete: number[] = [];
  let prevPrice: number | null = null;
  for (let i = 0; i < rows.length; i++) {
    const isLast = i === rows.length - 1;
    if (prevPrice !== null && rows[i].price === prevPrice && !isLast) {
      idsToDelete.push(rows[i].id);
    }
    prevPrice = rows[i].price;
  }

  if (idsToDelete.length > 0) {
    await supabase.from("quote_history").delete().in("id", idsToDelete);
  }

  return Response.json({ totalRows: rows.length, deleted: idsToDelete.length, kept: rows.length - idsToDelete.length });
});
