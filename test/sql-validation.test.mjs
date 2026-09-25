import { test as nodeTest } from 'node:test';
import { createValidationUI } from './helpers/validation-ui.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createContext, Script } from 'node:vm';

for (const artifact of ['bind-sql-for-eclipse-postgresql.html']) {
  const test = (name, callback) => nodeTest(`${artifact}: ${name}`, callback);
  const html = readFileSync(new URL(`../${artifact}`, import.meta.url), 'utf8');
  const source = id => html.match(new RegExp(`<script id="${id}"[^>]*>([^]*?)</script>`))[1];
  const binary = Uint8Array.from(Buffer.from(source('postgresql-validator-wasm'), 'base64'));

  function createValidator(wasmBinary = binary) {
    const messages = [];
    const context = createContext({
      WebAssembly, TextDecoder, TextEncoder, URL, console, performance,
      setTimeout, clearTimeout,
      self: { location: { href: 'blob:local-test' }, postMessage: value => messages.push(value) },
      WorkerGlobalScope: class {},
      fetch: () => { throw new Error('Validator must not access the network'); }
    });
    new Script(source('postgresql-validator-worker')).runInContext(context);
    let id = 0;
    return async sql => {
      id++;
      await context.self.onmessage({ data: { id, sql, wasmBinary: id === 1 ? wasmBinary : undefined } });
      const result = messages.at(-1);
      assert.equal(result.id, id);
      return result;
    };
  }

  const validate = createValidator();

  test('shipped parser, worker and license bundle is reproducible', () => {
    execFileSync(process.execPath, ['scripts/build-validator.mjs', '--check', '--target', artifact], { cwd: new URL('../', import.meta.url) });
  });

  const valid = [
    "SELECT DISTINCT ON (id) id, payload->>'name' FROM items WHERE name ILIKE 'a%' ORDER BY id;",
    "SELECT ARRAY[1,2], 'a'::text, $$it's (a,b)$$, E'escaped\\ntext';",
    "INSERT INTO t (a,b,c) VALUES (1, concat('x,y', 'z'), (SELECT count(*) FROM s));",
    "INSERT INTO t (a,b) VALUES (1,2),(3,DEFAULT) ON CONFLICT(a) DO UPDATE SET b=excluded.b RETURNING *;",
    "INSERT INTO t DEFAULT VALUES;",
    "INSERT INTO t VALUES (1);",
    "INSERT INTO t (a) VALUES (1);",
    'INSERT INTO t (a,"A") VALUES (1,2);',
    'INSERT INTO t (a[1],a[2]) VALUES (1,2);',
    'INSERT INTO t (a.x,a.y) VALUES (1,2);',
    'INSERT INTO t (a,b) SELECT * FROM s;',
    'INSERT INTO t (a,b) SELECT (s).* FROM s;',
    'INSERT INTO t (a,b) VALUES ((ROW(1,2)).*);',
    'INSERT INTO t (a) SELECT (SELECT count(*) FROM s);',
    'SELECT * FROM s UNION SELECT 1,2;',
    'WITH x AS (SELECT 1 a, 2 b) INSERT INTO t (a,b) SELECT a,b FROM x;',
    'UPDATE t SET (a,b) = (1,2);',
    'UPDATE t SET (a,b) = (SELECT * FROM s);',
    'MERGE INTO t USING s ON t.id=s.id WHEN MATCHED THEN UPDATE SET a=s.a;',
    "SELECT '日本語😀'; SELECT 1;"
  ];
  for (const sql of valid) test(`accepts PG15: ${sql}`, async () => {
    const result = await validate(sql);
    assert.equal(result.status, 'checked', JSON.stringify(result));
    assert.equal(result.issues.length, 0);
  });

  const invalid = [
    ['SELECT (1;', 'syntax'],
    ["SELECT 'unclosed;", 'syntax'],
    ['INSERT INTO t (a,b) VALUES (1);', 'insert-count'],
    ['INSERT INTO t (a) VALUES (1,2);', 'insert-count'],
    ['INSERT INTO t (a,b) VALUES (1,2),(3);', 'insert-count'],
    ['INSERT INTO t VALUES (1,2),(3);', 'values-count'],
    ['VALUES (1), (2,3);', 'values-count'],
    ['INSERT INTO t (a,a) VALUES (1,2);', 'insert-duplicate-column'],
    ['INSERT INTO t (A,a) VALUES (1,2);', 'insert-duplicate-column'],
    ['INSERT INTO t (a,a[1]) VALUES (1,2);', 'insert-duplicate-column'],
    ['INSERT INTO t (a,b) SELECT count(*) FROM s;', 'insert-select-count'],
    ['INSERT INTO t (a) SELECT FROM s;', 'insert-select-count'],
    ['SELECT 1 UNION SELECT 1,2;', 'set-count'],
    ['SELECT 1 INTERSECT SELECT 1,2;', 'set-count'],
    ['SELECT 1 EXCEPT SELECT 1,2;', 'set-count'],
    ['INSERT INTO t (a,b) SELECT 1 UNION SELECT 2;', 'insert-select-count'],
    ['WITH x AS (INSERT INTO t (a,b) VALUES (1) RETURNING *) SELECT * FROM x;', 'insert-count'],
    ['UPDATE t SET (a,b) = (1,2,3);', 'assignment-count'],
    ['UPDATE t SET (a,b) = (SELECT 1);', 'assignment-count'],
    ['SELECT 1; INSERT INTO t (a,b) VALUES (1);', 'insert-count'],
    ['SELECT 1\0; DROP TABLE t;', 'syntax'],
    // PostgreSQL 16 allows a FROM subquery without an alias; PostgreSQL 15 does not.
    ['SELECT * FROM (SELECT 1);', 'syntax']
  ];
  for (const [sql, code] of invalid) test(`detects ${code}: ${sql}`, async () => {
    const result = await validate(sql);
    assert.equal(result.status, 'error', JSON.stringify(result));
    assert.ok(result.issues.some(issue => issue.code === code), JSON.stringify(result));
  });

  test('error locations use UTF-16 offsets after Japanese and supplementary characters', async () => {
    const sql = "SELECT '日本語😀';\nSELECT FROM;";
    const result = await validate(sql);
    assert.equal(result.issues[0].offset, sql.lastIndexOf(';'));
    const insert = "SELECT '日本語😀';\nINSERT INTO t (a,b) VALUES (7);";
    const structural = await validate(insert);
    assert.equal(structural.issues[0].offset, insert.lastIndexOf('7'));
  });

  test('comments and empty input are not reported as checked statements', async () => {
    for (const sql of ['', '   ', '-- only a comment\n', '/* comment */;']) {
      assert.equal((await validate(sql)).status, 'empty');
    }
  });

  test('reports all independent structural errors in source order', async () => {
    const result = await validate('INSERT INTO t (a,b) VALUES (1); INSERT INTO u (a) VALUES (2,3);');
    assert.equal(result.issues.length, 2);
    assert.ok(result.issues[0].offset < result.issues[1].offset);
  });

  test('repeated assignment AST nodes do not duplicate the same error', async () => {
    const result = await validate('UPDATE t SET (a,b) = (SELECT 1 UNION SELECT 1,2);');
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].code, 'set-count');
  });

  test('parser initialization failure is unavailable, never checked', async () => {
    const unavailable = createValidator(new Uint8Array([0, 1, 2]));
    assert.equal((await unavailable('SELECT 1')).status, 'unavailable');
  });

  test('parser recovers after syntax errors and processes a large VALUES list', async () => {
    await validate('SELECT FROM;');
    const sql = `INSERT INTO t (a,b) VALUES ${Array.from({ length: 4000 }, (_, i) => `(${i},'a,b')`).join(',')};`;
    assert.equal((await validate(sql)).status, 'checked');
    assert.equal((await validate('SELECT 1;')).status, 'checked');
  });

  test('initial NUL input does not lose the transferred parser binary', async () => {
    const fresh = createValidator();
    assert.equal((await fresh('SELECT 1\0')).status, 'error');
    assert.equal((await fresh('SELECT 1;')).status, 'checked');
  });

  const createUI = () => createValidationUI(source('sql-validation-ui'));

  test('debounces edits, ignores stale responses, and clears diagnostics immediately', () => {
    const ui = createUI();
    ui.controller.schedule('SELECT 1');
    ui.tick(300);
    const worker = ui.workers[0];
    const oldId = worker.sent.id;
    ui.controller.schedule('SELECT 2');
    worker.respond('error', [{ message: 'old', offset: 0 }], oldId);
    assert.equal(ui.get('[data-role="validation"]').dataset.status, 'checking');
    ui.tick(300);
    ui.workers.at(-1).respond('checked');
    assert.equal(ui.get('[data-role="validation"]').dataset.status, 'checked');
    ui.controller.reset();
    worker.respond('error', [{ message: 'stale', offset: 0 }]);
    assert.equal(ui.get('[data-role="validation"]').hidden, true);
    assert.equal(worker.terminated, true);
  });

  test('diagnostics are text-only, and location selects the output character', () => {
    const ui = createUI();
    ui.controller.schedule("SELECT '日本語😀';\nSELECT FROM;");
    ui.tick(300);
    ui.workers[0].respond('error', [{ message: '<img src=x onerror=alert(1)>', offset: 26 }]);
    const item = ui.get('[data-role="validation-issues"]').children[0];
    assert.equal(item.children.at(-1).textContent, '<img src=x onerror=alert(1)>');
    item.children[0].click();
    assert.equal(ui.get('[data-role="output"]').focused, true);
    assert.deepEqual(ui.get('[data-role="output"]').selection, [26, 27]);
    assert.equal(ui.get('[data-role="output"]').attributes['aria-invalid'], 'true');
    assert.equal(ui.get('[data-role="output"]').value, undefined, 'validation must not change SQL');
  });

  test('timeout cannot turn into success and the next edit starts a fresh worker', () => {
    const ui = createUI();
    ui.controller.schedule('SELECT 1');
    ui.tick(300);
    const worker = ui.workers[0];
    ui.tick(10000);
    assert.equal(worker.terminated, true);
    worker.respond('checked');
    assert.equal(ui.get('[data-role="validation"]').dataset.status, 'unavailable');
    ui.controller.schedule('SELECT 2');
    ui.tick(300);
    assert.equal(ui.workers.length, 2);
    ui.workers[1].respond('checked');
    assert.equal(ui.get('[data-role="validation"]').dataset.status, 'checked');
  });

}
