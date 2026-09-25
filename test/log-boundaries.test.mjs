import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadModule, parseSync } from 'libpg-query';
import { createApp } from './helpers/business-app.mjs';
await loadModule();
const ast = sql => JSON.parse(JSON.stringify(parseSync(sql), (key, value) =>
  ['location', 'stmt_location', 'stmt_len'].includes(key) ? undefined : value));
const quote = value => `'${value.replaceAll("'", "''")}'`;
function equivalent(input, expected) {
  const app = createApp(); const output = app.input(input);
  assert.equal(app.copy.disabled, false, output);
  assert.deepEqual(ast(output), ast(expected), output);
}

test('log control markers inside MyBatis values are data, not commands', () => {
  const value = '==> Preparing: delete from t --';
  equivalent(`==> Preparing: select ?\n==> Parameters: ${value}(String)`, `select ${quote(value)}`);
});
test('log control markers inside Hibernate values are data, not commands', () => {
  const value = 'Hibernate: delete from t --';
  equivalent(`Hibernate: select ?\nbinding parameter [1] as [VARCHAR] - [${value}]`, `select ${quote(value)}`);
});
test('log control markers inside Spring values are data, not commands', () => {
  const value = 'Executing prepared SQL statement [delete from t]';
  equivalent(`Executing prepared SQL statement [select ?]\ncolumn index 1, parameter value [${value}], value class [java.lang.String]`, `select ${quote(value)}`);
});
test('multiline SQL bodies cannot introduce MyBatis records', () => {
  const sql = "select $$\n==> Preparing: delete from t --\n$$, ?";
  equivalent(`==> Preparing: ${sql}\n==> Parameters: 7(Integer)`, sql.replace('?', '7'));
});
test('multiline SQL bodies cannot introduce Hibernate records', () => {
  const sql = "select $$\nHibernate: delete from t --\n$$, ?";
  equivalent(`Hibernate: ${sql}\nbinding parameter [1] as [INTEGER] - [7]`, sql.replace('?', '7'));
});
test('multiline SQL bodies cannot introduce Spring records', () => {
  const sql = "select $$\nExecuting prepared SQL statement [delete from t]\n$$, ?";
  equivalent(`Executing prepared SQL statement [${sql}]\ncolumn index 1, parameter value [7], value class [java.lang.Integer]`, sql.replace('?', '7'));
});
test('mixed log formats select the final SQL record in input order', () => {
  const records = [
    ['==> Preparing: select ?\n==> Parameters: 1(Integer)', 'select 1'],
    ['Hibernate: select ?\nbinding parameter (1:INTEGER) <- [2]', 'select 2'],
    ['Executing prepared SQL statement [select ?]\ncolumn index 1, parameter value [3], value class [java.lang.Integer]', 'select 3']
  ];
  for (const first of records) for (const last of records) if (first !== last) equivalent(first[0] + '\n' + last[0], last[1]);
});
test('Eclipse parameter blocks support an apostrophe in unquoted text', () => {
  equivalent("sql=[select ?,?] params=[1=O'Reilly, 2=7]", "select 'O''Reilly',7");
});
test('wrapped and line-based binds use identical literal normalization', () => {
  equivalent("sql=[select ?, ?] params=[1=E'a\\nb', 2=$$hello$$]", "select E'a\\nb', $$hello$$");
});
test('generated CR and backslash values survive textarea newline normalization', () => {
  const app = createApp();
  const output = app.input('select ?\nparams:\n1="a\\r\\nb\\\\c"');
  assert.equal(app.copy.disabled, false);
  assert.ok(!output.includes('\r'));
  assert.deepEqual(ast(output), ast("select E'a\\r\\nb\\\\c'"));
});
