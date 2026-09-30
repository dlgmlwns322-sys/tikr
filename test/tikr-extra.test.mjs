import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

// tikr-extra 순수 로직(logic.ts)을 타입만 지워 그대로 불러온다.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const js = stripTypeScriptTypes(readFileSync(join(root, 'supabase/functions/tikr-extra/logic.ts'), 'utf8'));
const L = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

const jwt = (payload) => 'x.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.y';

test('bearerRole: service_role만 통과, 깨진 토큰은 null', () => {
  assert.equal(L.bearerRole('Bearer ' + jwt({ role: 'service_role' })), 'service_role');
  assert.equal(L.bearerRole('Bearer ' + jwt({ role: 'anon' })), 'anon');
  assert.equal(L.bearerRole(null), null);
  assert.equal(L.bearerRole('Bearer abc'), null);
  assert.equal(L.bearerRole('Bearer x.@@@.y'), null);
});

test('maskSecrets: FRED api_key·Finnhub token 가림', () => {
  const m = 'error sending request for url (https://api.stlouisfed.org/fred/series/observations?series_id=VIXCLS&api_key=abcd1234&file_type=json)';
  const out = L.maskSecrets(m);
  assert.ok(!out.includes('abcd1234'));
  assert.ok(out.includes('api_key=***&file_type=json'));
  assert.equal(L.maskSecrets('x?token=k9)'), 'x?token=***)');
  assert.equal(L.maskSecrets('KIS CTPF1702R 재시도 초과'), 'KIS CTPF1702R 재시도 초과');
});

test('vixStart: 마지막 저장일 10일 전, 없으면 400일 전', () => {
  assert.equal(L.vixStart('2026-09-30', '2026-10-01'), '2026-09-20');
  assert.equal(L.vixStart(null, '2026-10-01'), '2025-08-27');
  assert.equal(L.vixStart('bad', '2026-10-01'), '2025-08-27');
  assert.equal(L.addDays('2026-03-01', -1), '2026-02-28');
});

test('parseFred: 값 "."·비숫자·0·음수·날짜 이상 버림', () => {
  const rows = L.parseFred({ observations: [
    { date: '2026-09-28', value: '16.25' }, { date: '2026-09-29', value: '.' }, { date: '2026-09-30', value: '0' },
    { date: '2026-10-01', value: '-3' }, { date: '20261002', value: '15' }, { date: '2026-10-03', value: '1e3' },
    { date: '2026-10-04', value: 17 }, { date: '2026-10-05', value: '17.5' },
  ] });
  assert.deepEqual(rows, [['VIX', '2026-09-28', 16.25], ['VIX', '2026-10-05', 17.5]]);
  assert.deepEqual(L.parseFred(null), []);
  assert.deepEqual(L.parseFred({ observations: 'x' }), []);
});

test('usTypeCodes: 거래소 먼저, 모르면 나스닥·뉴욕·아멕스 순', () => {
  assert.deepEqual(L.usTypeCodes('NYS'), ['513', '512', '529']);
  assert.deepEqual(L.usTypeCodes('AMS'), ['529', '512', '513']);
  assert.deepEqual(L.usTypeCodes(null), ['512', '513', '529']);
  assert.deepEqual(L.usTypeCodes('XXX'), ['512', '513', '529']);
});

test('pickName: 한글 이름 우선·공백 정리·60자·없으면 null', () => {
  assert.equal(L.pickName({ prdt_name: ' 마이크론  테크놀로지 ', prdt_eng_name: 'MICRON' }, 'US'), '마이크론 테크놀로지');
  assert.equal(L.pickName({ prdt_name: '', prdt_eng_name: 'MICRON TECH' }, 'US'), 'MICRON TECH');
  assert.equal(L.pickName({ prdt_abrv_name: '삼성전자', prdt_name: '삼성전자보통주' }, 'KR'), '삼성전자');
  assert.equal(L.pickName({ prdt_abrv_name: '  ', prdt_name: 'SK하이닉스' }, 'KR'), 'SK하이닉스');
  assert.equal(L.pickName({ prdt_name: 'x'.repeat(80) }, 'US').length, 60);
  assert.equal(L.pickName(null, 'US'), null);
  assert.equal(L.pickName({}, 'KR'), null);
});
