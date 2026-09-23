import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

test('24시간 자동 수집은 BTC_KRW 하나를 15분 간격으로 유지한다', () => {
  const macro = read('supabase/functions/macro-poll/index.ts');
  const upbit = read('supabase/functions/upbit-quote/index.ts');

  assert.doesNotMatch(macro, /call\("binance-quote"\)/);
  assert.match(macro, /minute\s*%\s*15\s*===\s*0/);
  assert.match(macro, /if\s*\(minute\s*%\s*15\s*===\s*0\)[\s\S]*call\("upbit-quote"\)/);
  assert.match(upbit, /const MARKETS = \["KRW-BTC"\];/);
});

test('프론트 Supabase 조회는 필요한 필드와 500행 상한만 사용한다', () => {
  const html = read('index.html');

  assert.match(html, /select\('price,percent_change,fetched_at'\)[\s\S]*limit\(30\)/);
  assert.doesNotMatch(html, /limit\(2000\)/);
  assert.match(html, /limit\(500\)/);
});

// ---- check-price-alerts / macro-poll 조회·응답량 회귀 검사 ----

// Edge Function 소스를 jsr import 없이 실행해 Deno.serve 핸들러를 꺼낸다. Date·fetch·createClient는 주입한 가짜로 대체.
function loadHandler(path, { now, createClient, fetch }) {
  const js = stripTypeScriptTypes(read(path).replace(/^import .*$/m, ''));
  let handler;
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
  }
  const Deno = { env: { get: () => 'x' }, serve: (fn) => { handler = fn; } };
  new Function('Deno', 'createClient', 'fetch', 'Date', js)(Deno, createClient, fetch, FakeDate);
  return handler;
}

// PostgREST 체인을 흉내 내는 최소 가짜 클라이언트. 요청을 기록한다.
function fakeSupabase({ alerts, quotes }) {
  const log = [];
  const run = (q) => {
    if (q.table === 'price_alerts' && q.op === 'select') return { data: alerts.filter((a) => a.enabled), error: null };
    if (q.table === 'price_alerts' && q.op === 'update') {
      const id = q.filters.find((f) => f[1] === 'id')[2];
      const a = alerts.find((x) => x.id === id);
      if (q.filters.some((f) => f[1] === 'enabled') && !a.enabled) return { data: [], error: null };
      Object.assign(a, q.value);
      return { data: q.cols ? [{ id }] : null, error: null };
    }
    if (q.table === 'quote_history') {
      const inF = q.filters.find((f) => f[0] === 'in');
      const eqF = q.filters.find((f) => f[0] === 'eq' && f[1] === 'symbol');
      const rows = [...quotes]
        .sort((x, y) => y.fetched_at.localeCompare(x.fetched_at))
        .filter((r) => (!inF || inF[2].includes(r.symbol)) && (!eqF || r.symbol === eqF[2]));
      return { data: rows.slice(0, q.limit), error: null };
    }
    throw new Error('unexpected query ' + JSON.stringify(q));
  };
  const client = {
    from(table) {
      const q = { table, op: 'select', filters: [], cols: null };
      const b = {
        select(cols) { q.cols = cols ?? '*'; return b; },
        update(v) { q.op = 'update'; q.value = v; return b; },
        eq(k, v) { q.filters.push(['eq', k, v]); return b; },
        in(k, v) { q.filters.push(['in', k, v]); return b; },
        order() { return b; },
        limit(n) { q.limit = n; return b; },
        then(res, rej) { log.push(q); return Promise.resolve(run(q)).then(res, rej); },
      };
      return b;
    },
  };
  return { client, log };
}

async function runAlerts({ now, alerts, quotes }) {
  const { client, log } = fakeSupabase({ alerts, quotes });
  const sent = [];
  const fetch = async (url, init) => {
    if (String(url).includes('api.telegram.org')) sent.push(JSON.parse(init.body).text);
    return new Response('{}');
  };
  const handler = loadHandler('supabase/functions/check-price-alerts/index.ts', { now, createClient: () => client, fetch });
  const body = await (await handler()).json();
  return { body, log, sent, alerts };
}

// 2026-09-26(토) 12:00 KST — 한국·미국 장 모두 닫힘
const WEEKEND = '2026-09-26T03:00:00Z';
// 2026-09-23(수) 10:00 KST — 한국장 열림, 미국장 닫힘
const KR_OPEN = '2026-09-23T01:00:00Z';

test('check-price-alerts는 price_alerts를 필요한 컬럼만 조회한다', () => {
  const src = read('supabase/functions/check-price-alerts/index.ts');
  assert.doesNotMatch(src, /\.select\("\*"\)/);
  assert.doesNotMatch(src, /\.select\(\)/);
  assert.match(src, /\.select\("id,symbol,kind,direction,threshold,last_fired_session"\)/);
});

test('check-price-alerts: 장 마감 시장 심볼만 있으면 quote_history 조회 없이 조기 종료한다', async () => {
  const alerts = [
    { id: 1, symbol: 'AAPL', kind: 'pct', direction: 'below', threshold: -1, last_fired_session: null, enabled: true },
    { id: 2, symbol: '005930.KS', kind: 'price', direction: 'above', threshold: 1, last_fired_session: null, enabled: true },
  ];
  const quotes = [
    { symbol: 'AAPL', price: 100, percent_change: -5, fetched_at: '2026-09-25T19:59:00Z' },
    { symbol: '005930.KS', price: 70000, percent_change: 1, fetched_at: '2026-09-25T06:29:00Z' },
  ];
  const r = await runAlerts({ now: WEEKEND, alerts, quotes });
  assert.equal(r.body.skipped, 'markets closed');
  assert.deepEqual(r.sent, []);
  assert.equal(r.log.filter((q) => q.table === 'quote_history').length, 0);
});

test('check-price-alerts: 24시간 시장 심볼(코인)이 있으면 장 마감에도 전체를 평가한다', async () => {
  const alerts = [
    { id: 1, symbol: 'AAPL', kind: 'pct', direction: 'below', threshold: -1, last_fired_session: null, enabled: true },
    { id: 2, symbol: 'BTC_KRW', kind: 'price', direction: 'above', threshold: 100, last_fired_session: null, enabled: true },
  ];
  const quotes = [
    { symbol: 'AAPL', price: 100, percent_change: -5, fetched_at: '2026-09-25T19:59:00Z' },
    { symbol: 'BTC_KRW', price: 150, percent_change: 0.5, fetched_at: '2026-09-26T02:45:00Z' },
  ];
  const r = await runAlerts({ now: WEEKEND, alerts, quotes });
  assert.equal(r.body.skipped, undefined);
  assert.deepEqual(r.body.fired.sort(), ['AAPL(pct)', 'BTC_KRW(price)']);
  assert.equal(r.alerts[1].enabled, false);
});

test('check-price-alerts: 최신가는 묶음 1회 조회 + 빠진 심볼만 개별 조회로 심볼별 최신 행을 쓴다', async () => {
  const alerts = [
    { id: 1, symbol: 'KOSPI', kind: 'pct', direction: 'above', threshold: 1, last_fired_session: null, enabled: true },
    { id: 2, symbol: 'USD_KRW', kind: 'price', direction: 'below', threshold: 1300, last_fired_session: null, enabled: true },
  ];
  const quotes = [
    // KOSPI 최근 행이 상위 4행을 채워서 USD_KRW는 묶음 조회에 안 들어온다 → 개별 조회로 보충
    ...[0, 1, 2, 3, 4].map((i) => ({ symbol: 'KOSPI', price: 3000 + i, percent_change: i === 4 ? 1.5 : 0.1, fetched_at: `2026-09-23T00:5${i}:00Z` })),
    { symbol: 'USD_KRW', price: 1290, percent_change: -0.2, fetched_at: '2026-09-22T23:00:00Z' },
    { symbol: 'USD_KRW', price: 1350, percent_change: 0.1, fetched_at: '2026-09-22T22:00:00Z' },
  ];
  const r = await runAlerts({ now: KR_OPEN, alerts, quotes });
  assert.deepEqual(r.body.fired.sort(), ['KOSPI(pct)', 'USD_KRW(price)']);
  assert.match(r.sent.find((t) => t.includes('KOSPI')), /1\.50%/);
  const qh = r.log.filter((q) => q.table === 'quote_history');
  assert.equal(qh.length, 2); // 묶음 1회 + USD_KRW 개별 1회 (KOSPI는 개별 조회 안 함)
  assert.ok(qh[0].filters.some((f) => f[0] === 'in'));
  assert.deepEqual(qh[1].filters.find((f) => f[1] === 'symbol'), ['eq', 'symbol', 'USD_KRW']);

  // 같은 세션 재실행: pct 알림은 다시 안 오고, 1회성 목표가 알림은 이미 꺼져 있다
  const again = await runAlerts({ now: KR_OPEN, alerts: r.alerts, quotes });
  assert.deepEqual(again.body.fired, []);
});

test('macro-poll은 하위 함수 body를 싣지 않고 path·ok·status 요약만 반환한다', async () => {
  const src = read('supabase/functions/macro-poll/index.ts');
  assert.match(src, /return \{ path, ok: res\.ok, status: res\.status \};/);

  const fetch = async () => new Response(JSON.stringify({ huge: 'x'.repeat(5000) }));
  // 2026-09-23(수) 10:00 KST(한국장 열림) + 분 % 15 === 0 → 4개 하위 함수 모두 호출
  const handler = loadHandler('supabase/functions/macro-poll/index.ts', { now: KR_OPEN, createClient: null, fetch });
  const body = await (await handler()).json();
  assert.deepEqual(body.results.map((r) => r.path), ['kis-index', 'kis-stock-quote', 'forex-quote', 'upbit-quote']);
  for (const r of body.results) assert.deepEqual(Object.keys(r).sort(), ['ok', 'path', 'status']);
  assert.ok(JSON.stringify(body).length < 300);
});