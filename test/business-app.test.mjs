import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadModule, parseSync } from 'libpg-query';
import { createApp } from './helpers/business-app.mjs';

await loadModule();
function ast(sql) {
  return JSON.parse(JSON.stringify(parseSync(sql), (key, value) =>
    ['location', 'stmt_location', 'stmt_len'].includes(key) ? undefined : value));
}
function equivalent(input, expected = input) {
  const expectedAst = ast(expected);
  const app = createApp();
  const output = app.input(input);
  assert.equal(app.copy.disabled, false, output);
  assert.deepEqual(ast(output), expectedAst, output);
  return output;
}

const unchanged = [
  'select 8 << 1, 8 >> 1;',
  'select ascii(name) from t order by name asc;',
  "select 'a\r\nb', $$c\rd$$;",
  "select 'a'\n'b';",
  'select 2026-09-07;',
  'select 1 /* outer /* inner */ :ignored ? */;',
  "select $日本語$? :name$日本語$;",
  'select @@BindSQL_SEGMENT_0@@ 1;',
  "select $$\nparams:\n1 = 42\nsql: leave me alone\n$$;",
  'select a[:upper], a[lower:upper] from t;',
  "select data ? 'x', data ?| array['a','b'], data ?& array['c'], data @? '$.x' from t;",
  'select 1e+10, 1e-10, 1.25, .5;',
  'select a + +b, a / @b from t;',
  'select foo$tag$ from t;',
  'select 1 -- a comment\nfrom t;',
  "select E'a\\n'::text, U&'d\\0061t', B'0101', X'abc';",
  "select 'a'\n\n'b';",
  "select * from t where name='abc' and value>=U&'d\\0061t';",
  "select data OPERATOR(pg_catalog.?) 'key' from t;",
  'select select名, as_name, ascending from 表;',
  'select 1 as"one", now() at time zone \'UTC\';',
  'select * from t limit all offset 1;',
  'select array[1,2], (array[1,2])[1:2];',
  'with x as (select 1 a) select a from x union all select 2;',
  'insert into t(a,b) values (1,2),(3,4) on conflict(a) do update set b=excluded.b returning *;',
  'update t set (a,b)=(select 1,2) where id=3;',
  'merge into t using s on t.id=s.id when matched then update set a=s.a when not matched then insert(id,a) values(s.id,s.a);',
  'select sum(a) over(partition by b order by c rows between 1 preceding and current row) from t;',
  'select case when a between 1 and 2 then true else false end from t;',
  'select * from t where exists(select 1 from s where s.id=t.id);',
  'select\nparams\nfrom t;',
  '/*\nHibernate: delete from t\n*/ select 1;',
  'select f(arg:=1, other=>2);'
];
for (const sql of unchanged) test(`formatter preserves PostgreSQL AST: ${JSON.stringify(sql)}`, () => equivalent(sql));

const bindings = [
  ['select distinct ? from t\nparams:\n1 = abc', "select distinct 'abc' from t"],
  ['select arr [ ? ] from t\n1 = 2', 'select arr[2] from t'],
  ['select * from t where id=? AND\n1 = 1\n1 = 7', 'select * from t where id=7 AND 1=1'],
  ['sql=[select ?, ?] params=[1 = {"a":1,"b":2}, 2 = 3]', 'select \'{"a":1,"b":2}\',3'],
  ["select :a, :b, ?\nparams:\na = ':b ?'\nb = '$&'\n1 = '@@BindSQL_SEGMENT_0@@'", "select ':b ?', '$&', '@@BindSQL_SEGMENT_0@@'"],
  ['select :key$, :key\nparams:\nkey$ = 2\nkey = 1', 'select 2,1'],
  ["select ? -- ? :ignored\n, :value::text\nparams:\n1 = O'Reilly\nvalue = 😀", "select 'O''Reilly', '😀'::text"],
  ['select /* comment */ ?\nparams:\n1 = 5', 'select 5'],
  ['select /* comment */ ? from t\nparams:\n1 = 5', 'select 5 from t'],
  ["select data ? /* comment */ 'key', ? from t\nparams:\n1 = 5", "select data ? 'key',5 from t"],
  ['select ? -- comment\nparams:\n1 = 5', 'select 5'],
  ['select ? ? ?\nparams:\n1 = {"key":1}\n2 = key', 'select \'{"key":1}\' ? \'key\''],
  ["select 本文 ? 'x', ? from t\nparams:\n1 = 7", "select 本文 ? 'x',7 from t"],
  ['select array[:x], a[(:y)] from t\nparams:\nx = 2\ny = 3', 'select array[2], a[(3)] from t'],
  ['select * from t where id=? AND\n2 = 3\n1 = 7', 'select * from t where id=7 AND 2=3'],
  ['select :id from t where\nid = 1\nid = 2', 'select 2 from t where id=1'],
];
for (const [input, expected] of bindings) test(`binds exact values: ${JSON.stringify(input)}`, () => equivalent(input, expected));

const logs = [
  ['==> Preparing: select ?\n==> Parameters: \'hello\'(String)', "select '''hello'''"],
  ['==> Preparing: select ?, ?\n==> Parameters:  abc (String), 123(String)', "select ' abc ', '123'"],
  ['Hibernate: select ?\nbinding parameter [1] as [VARCHAR] - [\'hello\']', "select '''hello'''"],
  ['2026-09-07 DEBUG org.hibernate.SQL :\n    select * from t where id=?\nbinding parameter [1] as [INTEGER] - [7]', 'select * from t where id=7'],
  ['Executing prepared SQL statement [select arr[1]\nfrom t where id = ?]\ncolumn index 1, parameter value [7], value class [java.lang.Integer], SQL type unknown', 'select arr[1] from t where id=7'],
  ['Executing prepared SQL statement [select ?]\ncolumn index 1, parameter value [ abc ], value class [java.lang.String], SQL type unknown', "select ' abc '"],
  ['Executing prepared SQL statement [select ?]\ncolumn index 1, parameter value [7], value class [java.lang.Integer]\nExecuting prepared SQL statement [delete from t where id=?]\ncolumn index 1, parameter value [9], value class [java.lang.Integer]', 'delete from t where id=9'],
  ['Hibernate: select ?, ?\nbinding parameter [1] as [INTEGER] - [7]\nbinding parameter [2] as [INTEGER] - [8]\nHibernate: select ?\nbinding parameter [1] as [INTEGER] - [9]', 'select 9'],
  ["==> Preparing: select ?, ?, ?, ?\n==> Parameters: (String), null(String), null, O'Reilly(String)", "select '', 'null', NULL, 'O''Reilly'"],
  ["Executing prepared SQL statement [select ']' as s, ?]\ncolumn index 1, parameter value [a]b], value class [java.lang.String]", "select ']' as s,'a]b'"],
  ["select $$\n==> Preparing: delete from t\n$$;", "select $$\n==> Preparing: delete from t\n$$;"],
];
for (const [input, expected] of logs) test(`log fidelity: ${JSON.stringify(input)}`, () => equivalent(input, expected));

test('new log statement never inherits values from the previous statement', () => {
  const app = createApp();
  const result = app.input('==> Preparing: select ?\n==> Parameters: 7(Integer)\n==> Preparing: delete from t where id=?');
  assert.equal(app.copy.disabled, true);
  assert.match(result, /未置換の位置バインド/);
});

test('missing and surplus binds block copying and skip syntax validation', () => {
  for (const input of ['select ?, ?\n1 = 7', 'select :a\nparams:\nb = 2', 'select ?\nparams:\n1 = 7\n2 = 8']) {
    const app = createApp();
    app.input(input);
    assert.equal(app.copy.disabled, true);
    assert.equal(app.validation.at(-1).kind, 'reset');
  }
});

test('duplicate bind definitions cannot silently overwrite data', () => {
  for (const input of ['select ?\nparams:\n1 = 1\n1 = 2', 'select :id\nparams:\nid = 1\nid = 2', 'select 1\nparams:\n0 = 2', 'select 1\nparams:\n9007199254740993 = 2']) {
    const app = createApp();
    app.input(input);
    assert.equal(app.copy.disabled, true, app.output.value);
    assert.equal(app.validation.at(-1).kind, 'reset');
  }
});

test('large input exercises the shipped formatter and binder without truncation', () => {
  const rows = Array.from({ length: 2000 }, (_, i) => `(${i},'row ${i}')`).join(',');
  equivalent(`insert into t(id,name) values ${rows};`);
});

test('long placeholder/operator chains do not overflow the JavaScript stack', () => {
  const app = createApp();
  app.input(`select ${Array(6000).fill('?').join(' ')};`);
  assert.equal(app.copy.disabled, true);
  assert.match(app.output.value, /未置換の位置バインド/);
});

test('parameter punctuation and Unicode are preserved across 80 generated round trips', () => {
  const values = ['', ' ', "a'b", ':x ?', '$&', '😀日本語', '\\', '{"a":[1,2]}', '@@BindSQL_SEGMENT_0@@', '<script>'];
  for (let i = 0; i < 80; i++) {
    const value = `${values[i % values.length]}${i}`;
    const literal = `'${value.replaceAll("'", "''")}'`;
    equivalent(`select :value, ?::text\nparams:\nvalue = ${literal}\n1 = ${literal}`, `select ${literal}, ${literal}::text`);
  }
});

test('input highlighting escapes injected HTML', () => {
  const app = createApp();
  app.input("select '<img src=x onerror=alert(1)>';");
  const highlighted = app.node('[data-role="raw-highlight"]').innerHTML;
  assert.ok(!highlighted.includes('<img'));
  assert.ok(highlighted.includes('&lt;img'));
});

const settle = () => new Promise(resolve => setImmediate(resolve));
test('clipboard fallback restores focus and selection; clear resets output', async () => {
  const app = createApp({ clipboard: { async writeText() { throw new Error('denied'); } } });
  const sql = app.input('select 1;');
  app.raw.focus(); app.raw.setSelectionRange(2, 5);
  app.click('copy'); await settle();
  assert.deepEqual(app.copied, [sql]);
  assert.equal(app.document.activeElement, app.raw);
  assert.equal(app.raw.selectionStart, 2); assert.equal(app.raw.selectionEnd, 5);
  assert.equal(app.copy.dataset.copied, 'true');
  app.tick(2000); assert.equal(app.copy.dataset.copied, 'false');
  app.click('clear'); assert.equal(app.copy.disabled, true); assert.equal(app.raw.value, '');
});

test('pending clipboard writes cannot overlap after an edit or show stale success', async () => {
  const requests = [];
  const app = createApp({ clipboard: { writeText(sql) { return new Promise(resolve => requests.push({ sql, resolve })); } } });
  app.input('select 1;'); app.click('copy');
  app.input('select 2;'); app.click('copy');
  assert.equal(requests.length, 1);
  requests[0].resolve(); await settle();
  assert.equal(app.copy.dataset.copied, 'false');
  app.click('copy'); assert.equal(requests.length, 2);
  requests[1].resolve(); await settle();
  assert.equal(app.copy.dataset.copied, 'true');
});

test('clipboard failure does not report success and releases the busy state', async () => {
  const app = createApp({ clipboard: { async writeText() { throw new Error('denied'); } }, fallback: false });
  app.input('select 1;'); app.click('copy'); await settle();
  assert.equal(app.copy.dataset.copied, 'false');
  assert.equal(app.copy.disabled, false);
  assert.equal(app.copy.getAttribute('aria-busy'), undefined);
  assert.equal(app.node('[data-role="flash"]').textContent, 'コピーに失敗しました');
});

test('blocked storage does not prevent editing or theme changes', () => {
  const app = createApp({ storage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } });
  const output = app.input('select 1;');
  const toggle = app.node('[data-role="mode-toggle"]');
  toggle.checked = false;
  app.dispatch('input', toggle);
  assert.equal(app.document.documentElement.dataset.theme, 'dark');
  assert.equal(app.output.value, output);
});
