import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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