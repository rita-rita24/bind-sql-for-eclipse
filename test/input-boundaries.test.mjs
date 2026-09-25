import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadModule, parseSync } from 'libpg-query';
import { createApp } from './helpers/business-app.mjs';

await loadModule();
const ast = sql => JSON.parse(JSON.stringify(parseSync(sql), (key, value) =>
  ['location', 'stmt_location', 'stmt_len'].includes(key) ? undefined : value));
const quote = value => `'${value.replaceAll("'", "''")}'`;
function equivalent(input, expected = input) {
  const app = createApp();
  const output = app.input(input);
  assert.equal(app.copy.disabled, false, output);
  assert.deepEqual(ast(output), ast(expected), output);
}

const bindings = [
  ['select now() at time zone ? from t\nparams:\n1=UTC', "select now() at time zone 'UTC' from t"],
  ['select now() at time /* zone */ zone ? from t\nparams:\n1=UTC', "select now() at time zone 'UTC' from t"],
  ['sql=[select ?, ?] params=[1=$$hello, world$$, 2=7]', 'select $$hello, world$$,7'],
  ['sql=[select ?, ?] params=[1=$日本語$a, [b], c$日本語$, 2=7]', 'select $日本語$a, [b], c$日本語$,7'],
  ["sql=[select ?, ?] params=[1='C:\\', 2=7]", "select 'C:\\',7"],
  ["sql=[select ?, ?] params=[1=E'a\\\'b,c', 2=7]", "select E'a\\\'b,c',7"],
  ['select ARRAY /* contents */ [:a] from t\nparams:\na=1', 'select ARRAY[1] from t'],
  ['select ARRAY[arr[:upper], arr[(:a)]] from t\nparams:\na=1', 'select ARRAY[arr[:upper], arr[(1)]] from t'],
  ['select ARRAY[[:a], [:b]]\nparams:\na=1\nb=2', 'select ARRAY[[1], [2]]'],
];
for (const [input, expected] of bindings) test(`parameter boundary: ${JSON.stringify(input)}`, () => equivalent(input, expected));

for (const sql of [
  'select data ? -1 from t', "select zone ? 'key' from t", "select data ?? 'key' from t",
  'select\n\u00a0', 'select \u3000', 'select \u00a0\nfrom t',
  "select \u3000 ? 'x' from t", 'select data OPERATOR("pg_catalog" . ?) \'key\' from t',
  String.raw`select E'a'
'b\' ? :x', 7;`,
]) test(`SQL token boundary: ${JSON.stringify(sql)}`, () => equivalent(sql));

for (const sql of [
  "CALL log('Hibernate: select 99');",
  "COPY t FROM '/tmp/Hibernate: select 99';",
  "EXPLAIN SELECT 'Hibernate: select 99';",
  "PREPARE s AS SELECT '==> Preparing: select 99';",
  "NOTIFY channel, 'Executing prepared SQL statement [select 99]';",
  "/* query */ EXPLAIN SELECT $$\n==> Preparing: delete from t\n$$;",
]) test(`SQL commands cannot be reinterpreted as logs: ${JSON.stringify(sql)}`, () => equivalent(sql));

test('continued escape strings do not consume a following placeholder or bind header', () => {
  const sql = String.raw`select E'a'
'b\' ? :x', ?`;
  equivalent(`${sql}\nparams:\n1=7`, String.raw`select E'a'
'b\' ? :x', 7`);
});

const logs = [
  value => `==> Preparing: select ?\n==> Parameters: ${value}(String)`,
  value => `Hibernate: select ?\nbinding parameter [1] as [VARCHAR] - [${value}]`,
  value => `Hibernate: select ?\nbinding parameter (1:VARCHAR) <- [${value}]`,
  value => `Executing prepared SQL statement [select ?]\ncolumn index 1, parameter value [${value}], value class [java.lang.String]`,
];
for (const [index, log] of logs.entries()) test(`multiline logged values retain all lines (${index})`, () => {
  for (const value of ['first\nsecond', 'first\n\n  last ', '\n日本語\n', "first\nO'Reilly"])
    equivalent(log(value), `select ${quote(value)}`);
});

test('truncated logged parameters never produce a successful partial value', () => {
  for (const input of [
    '==> Preparing: select ?\n==> Parameters: first',
    '==> Preparing: select ?\n==> Parameters: first\nsecond',
    '==> Preparing: select ?, ?\n==> Parameters: 1(Integer), truncated',
    'Hibernate: select ?\nbinding parameter [1] as [VARCHAR] - [first',
    'Executing prepared SQL statement [select ?]\ncolumn index 1, parameter value [first',
  ]) {
    const app = createApp(); app.input(input);
    assert.equal(app.copy.disabled, true, app.output.value);
  }
});

test('an incomplete log record keeps later record boundaries ambiguous and blocks copying', () => {
  for (const input of [
    '==> Preparing: select ?\n==> Parameters: truncated',
    'Hibernate: select ?\nbinding parameter [1] as [VARCHAR] - [truncated',
    'Executing prepared SQL statement [select ?]\ncolumn index 1, parameter value [truncated',
  ]) {
    const app = createApp();
    app.input(`${input}\n==> Preparing: select ?\n==> Parameters: 7(Integer)`);
    assert.equal(app.copy.disabled, true, app.output.value);
    assert.match(app.output.value, /truncated/);
  }
});

test('record-looking text in an unfinished logged string cannot become copyable SQL', () => {
  const app = createApp();
  app.input('==> Preparing: select ?\n==> Parameters: first\nHibernate: delete from t --\nlast(String)');
  assert.equal(app.copy.disabled, true, app.output.value);
});

test('wrapped continued escape strings protect commas and later parameter entries', () => {
  equivalent(String.raw`sql=[select ?, ?] params=[1=E'a'
'b\', c', 2=7]`, String.raw`select E'a'
'b\', c', 7`);
});

test('an empty MyBatis parameter record remains valid for SQL without placeholders', () => {
  equivalent('==> Preparing: select 1\n==> Parameters: ', 'select 1');
  equivalent('==> Preparing: select 1\n==> Parameters: \n<== Total: 1', 'select 1');
});

test('nested SQL comments remain comments in the input highlight', () => {
  const app = createApp();
  app.input('select /* outer /* inner */ SELECT 7 */ 1');
  assert.match(app.node('[data-role="raw-highlight"]').innerHTML,
    /sql-token--comment">\/\* outer \/\* inner \*\/ SELECT 7 \*\/<\/span>/);
});
