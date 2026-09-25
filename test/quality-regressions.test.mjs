import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadModule, parseSync } from 'libpg-query';
import { createApp } from './helpers/business-app.mjs';

await loadModule();
const ast = sql => JSON.parse(JSON.stringify(parseSync(sql), (key, value) =>
  ['location', 'stmt_location', 'stmt_len'].includes(key) ? undefined : value));
function equivalent(input, expected = input) {
  const reference = ast(expected);
  const app = createApp();
  const output = app.input(input);
  assert.equal(app.copy.disabled, false, output);
  assert.deepEqual(ast(output), reference, output);
  return output;
}

for (const literal of [
  "U&'!65E5!672C' UESCAPE '!'",
  "u&'a,,b' uescape ','",
  "U&'!+01F600' \t UESCAPE '!'",
  "U&'d!0061t'\nUESCAPE '!'",
]) test(`Unicode bind literal retains its escape clause: ${JSON.stringify(literal)}`, () => {
  equivalent(`select :value, ?\nparams:\nvalue=${literal}\n1=7`, `select ${literal},7`);
  equivalent(`sql=[select ?, :value] params=[1=7, value=${literal}]`, `select 7,${literal}`);
});

test('Unicode escape clauses stay attached to quoted identifiers and SQL strings', () => {
  equivalent(`select U&"d!0061t" UESCAPE '!', U&'!65E5!672C' UESCAPE '!' from t`);
  equivalent(`select U&'!65E5'\nUESCAPE '!'`);
});

test('continued parameter strings retain PostgreSQL newline concatenation', () => {
  for (const literal of ["'日本'\n'語'", "E'a'\n'b\\nc'", "B'01'\n'10'", "X'ab'\n'cd'"]) {
    equivalent(`select ?, :v\nparams:\n1=${literal}\nv=7`, `select ${literal},7`);
  }
});

test('continued parameter strings reject appended statements as literal data', () => {
  const app = createApp();
  app.input("select ?\nparams:\n1='a'\n'b'; delete from t;");
  assert.equal(app.copy.disabled, true);
});

test('Unicode bind literals cannot append executable SQL after an escape clause', () => {
  const value = "U&'!65E5' UESCAPE '!'; delete from t;";
  equivalent(`select ?\nparams:\n1=${value}`, `select '${value.replaceAll("'", "''")}'`);
});

test('truncated Unicode escape delimiters block copying and recover after completion', () => {
  const app = createApp();
  app.input("select ?\nparams:\n1=U&'!65E5' UESCAPE '!");
  assert.equal(app.copy.disabled, true);
  app.input("select ?\nparams:\n1=U&'!65E5' UESCAPE '!'");
  assert.equal(app.copy.disabled, false);
  assert.deepEqual(ast(app.output.value), ast("select '日'"));
});

for (const column of ['first', 'next', 'row', 'rows', 'set', 'values', 'between', 'by']) {
  test(`JSON operators accept the unreserved column name ${column}`, () => {
    for (const left of [column, `(${column})`, `t.${column}`]) {
      equivalent(`select ${left} ? 'key', ? from t\nparams:\n1=7`, `select ${left} ? 'key',7 from t`);
    }
    equivalent(`select 1 from t where ${column} /* operand */ ? 'key'`);
  });
}

test('contextual keywords still introduce positional parameters', () => {
  for (const [sql, value] of [
    ['select * from t fetch first ? rows only', 2],
    ['select * from t fetch next ? rows only', 2],
    ['select * from t order by ?', 1],
    ['select * from t group by ?', 1],
    ['select sum(x) over(partition by ?) from t', 1],
    ['select sum(x) over(order by id rows ? preceding) from t', 2],
    ['select sum(x) over(rows ? preceding) from t', 2],
    ['select sum(x) over w from t window w as (rows ? preceding)', 2],
    ['select * from t where id between ? and 10', 2],
    ['select * from t where id not between ? and 10', 2],
  ]) equivalent(`${sql}\nparams:\n1=${value}`, sql.replace('?', value));
});

test('JSON right operands may begin with PostgreSQL unary operators', () => {
  for (const operator of ['#', '~', '@', '!', '+', '-', '|/', '||/']) {
    equivalent(`select data ? ${operator}value, ? from t\nparams:\n1=7`, `select data ? ${operator}value,7 from t`);
  }
});

test('large multiline predicates retain every condition without repeatedly scanning SQL prefixes', () => {
  for (const header of ['params:\n', '']) {
    const scans = [];
    const app = createApp({
      beforeInit: ({ window }) => { window.recordContextScan = length => scans.push(length); },
      transformSource: source => source.replace(
        'const _getImplicitNamedPlaceholderCounts = (_sqlLines) => {',
        'const _getImplicitNamedPlaceholderCounts = (_sqlLines) => { window.recordContextScan(_sqlLines.length);'
      )
    });
    const count = 1200;
    const conditions = Array.from({ length: count }, (_, i) => `id=${i}`).join('\nand\n');
    app.input(`select ? from t where\n${conditions}\n${header}1=7`);
    assert.equal(app.copy.disabled, false, app.output.value);
    assert.equal((app.output.value.match(/\bid\s*=/g) ?? []).length, count);
    assert.match(app.output.value, /SELECT\s+7/i);
    assert.ok(scans.length <= 2, `scanned ${scans.length} growing prefixes`);
  }
});

test('returning from history during composition restores conversion for subsequent edits', () => {
  const app = createApp();
  app.input('select 1');
  app.dispatch('compositionstart', app.raw);
  app.raw.value = "select '日本'";
  app.dispatch('input', app.raw, { isComposing: true });
  app.dispatch('pagehide');
  app.dispatch('pageshow', undefined, { persisted: true });
  const result = app.input('select 2');
  assert.equal(app.copy.disabled, false);
  assert.deepEqual(ast(result), ast('select 2'));
});

test('clipboard fallback restores backward selections and both scroll positions', async () => {
  const app = createApp({ clipboard: { async writeText() { throw new Error('denied'); } } });
  const sql = app.input('select 1');
  app.raw.focus();
  Object.assign(app.raw, { selectionStart: 2, selectionEnd: 5, selectionDirection: 'backward', scrollTop: 220, scrollLeft: 130 });
  app.raw.setSelectionRange = function(start, end, direction) {
    Object.assign(this, { selectionStart: start, selectionEnd: end, selectionDirection: direction, scrollTop: 0, scrollLeft: 0 });
  };
  app.click('copy');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(app.copied, [sql]);
  assert.equal(app.document.activeElement, app.raw);
  assert.equal(app.raw.selectionStart, 2);
  assert.equal(app.raw.selectionEnd, 5);
  assert.equal(app.raw.selectionDirection, 'backward');
  assert.equal(app.raw.scrollTop, 220);
  assert.equal(app.raw.scrollLeft, 130);
});
