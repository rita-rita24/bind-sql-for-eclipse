import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, Script } from 'node:vm';
import { source } from './helpers/business-app.mjs';

const messages = [];
const context = createContext({ WebAssembly, TextEncoder, TextDecoder, URL, console, performance, setTimeout, clearTimeout,
  self: { location: { href: 'blob:test' }, postMessage: value => messages.push(value) }, WorkerGlobalScope: class {},
  fetch() { throw new Error('External access is forbidden'); }
});
new Script(source('postgresql-validator-worker')).runInContext(context);
const binary = Uint8Array.from(Buffer.from(source('postgresql-validator-wasm'), 'base64'));
let revision = 0;
async function validate(sql) {
  const id = ++revision;
  await context.self.onmessage({ data: { id, sql, wasmBinary: id === 1 ? binary : undefined } });
  return messages.at(-1);
}

test('non-ASCII spaces and vertical tabs are parsed instead of reported as empty', async () => {
  for (const sql of ['\u00a0', '\u3000', '\ufeff', '\v']) {
    const result = await validate(sql);
    assert.equal(result.status, 'error', JSON.stringify(result));
    assert.equal(result.issues[0].code, 'syntax');
    assert.equal(result.issues[0].offset, 0);
  }
});

test('MERGE INSERT clauses receive the same structural checks as INSERT', async () => {
  const prefix = 'MERGE INTO t USING s ON t.id=s.id WHEN NOT MATCHED THEN ';
  for (const tail of ['INSERT (a,b) VALUES (s.a)', 'INSERT (a,a) VALUES (s.a,s.b)']) {
    const result = await validate(prefix + tail);
    assert.equal(result.status, 'error');
    assert.ok(result.issues.some(issue => issue.code.startsWith('insert-')));
  }
  for (const tail of ['INSERT (a,b) VALUES (s.a,s.b)', 'INSERT DEFAULT VALUES', 'INSERT VALUES (s.a)']) {
    assert.equal((await validate(prefix + tail)).status, 'checked');
  }
});

test('dense diagnostics preserve every Unicode offset in source order', async () => {
  const sql = Array.from({ length: 1800 }, (_, i) => `INSERT INTO t(a,b) VALUES ('日本😀${i}');`).join('\n');
  const result = await validate(sql);
  assert.equal(result.status, 'error');
  assert.equal(result.issues.length, 1800);
  const offsets = [...sql.matchAll(/'日本😀\d+'/g)].map(match => match.index);
  assert.deepEqual(Array.from(result.issues, issue => issue.offset), offsets);
});

test('malformed worker input does not escape its failure boundary', async () => {
  await assert.doesNotReject(() => context.self.onmessage({ data: null }));
  assert.equal(messages.at(-1).status, 'unavailable');
  await assert.doesNotReject(() => context.self.onmessage({ data: { id: 999, sql: {} } }));
  assert.equal(messages.at(-1).status, 'unavailable');
  assert.equal((await validate('SELECT 1')).status, 'checked');
});

// 巨大なSQLをPostgreSQLで解析せずに、構文木の境界条件を検証する。
// 通常は非公開の純粋関数を、テスト時だけ公開する。
const workerSource = readFileSync(new URL('../src/sql-validation-worker-business.js', import.meta.url), 'utf8');
const structureContext = createContext({ self: {} });
new Script(workerSource.replace('  self.onmessage =', '  self.checkStructure = checkStructure;\n  self.onmessage =')).runInContext(structureContext);
const check = (tree, sql = '') => structureContext.self.checkStructure(tree, sql);

test('wide parser trees do not exceed the JavaScript argument limit', () => {
  const result = check({ items: Array.from({ length: 150000 }, () => ({})) });
  assert.equal(result.length, 0);
});

test('deep set operations do not recurse on the JavaScript call stack', () => {
  const leaf = () => ({ targetList: [{ ResTarget: { val: { A_Const: { ival: { ival: 1 } } } } }] });
  let query = leaf();
  for (let i = 0; i < 15000; i++) query = { op: 'SETOP_UNION', larg: query, rarg: leaf() };
  assert.equal(check({ SelectStmt: query }).length, 0);
});
