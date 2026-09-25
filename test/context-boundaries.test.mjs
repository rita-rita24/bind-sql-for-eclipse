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

for (const [sql, expected] of [
  ['select ? from t join u on\n1=1', 'select 7 from t join u on 1=1'],
  ['select ? from t having\n1=1', 'select 7 from t having 1=1'],
  ['select ? from t where x>0 and -- comment\n1=1', 'select 7 from t where x>0 and 1=1'],
  ['select ? from t where\n-- comment\n1=1', 'select 7 from t where 1=1'],
  ['select ? from t where /* outer /* inner */ end */\n1=1', 'select 7 from t where 1=1'],
  ['select ? as x,\n1=1', 'select 7 as x,1=1'],
  ['select ? from t where 1+\n1=2', 'select 7 from t where 1+1=2'],
]) test(`implicit binds keep a pending SQL expression: ${JSON.stringify(sql)}`, () => {
  equivalent(`${sql}\n1=7`, expected);
});

test('SQL predicates cannot silently supply a missing positional value', () => {
  const app = createApp();
  app.input('select ?, ? from t join u on\n1=1\n2=7');
  assert.equal(app.copy.disabled, true);
  assert.match(app.output.value, /未置換の位置バインド/);
  assert.match(app.output.value, /1\s*=\s*1/);
});

test('named binds preserve conditions after SQL comments', () => {
  equivalent('select :x from t where /* comment */\nx=1\nx=7', 'select 7 from t where x=1');
});

for (const name of ['where', 'returning', 'select', 'all', 'from', 'zone']) {
  test(`qualified ${name} is an operand before a JSON operator`, () => {
    for (const separator of ['.', ' . ', ' /* qualifier */ . /* field */ ']) {
      equivalent(`select t${separator}${name} ? 'key' from t`);
    }
  });
}

test('qualified ARRAY column names retain their array slices', () => {
  for (const qualifier of ['t.', 't . ', 't /* comment */ . /* comment */ ']) {
    equivalent(`select ${qualifier}array[:upper], ${qualifier}array[lower:upper] from t`);
    const app = createApp();
    app.input(`select ${qualifier}array[:upper] from t\nparams:\nupper=7`);
    assert.equal(app.copy.disabled, true, 'a slice bound is not a named placeholder');
    assert.match(app.output.value, /余剰の名前付きバインド/);
  }
});

test('implicit binds remain recognized after keyword-named columns', () => {
  equivalent('select :where, t.where from t\nwhere=7', 'select 7,t.where from t');
  equivalent('select ? as where_name from t\n1=7', 'select 7 as where_name from t');
  equivalent('select ?, *\n1=7', 'select 7,*');
  equivalent('select ?, t.*\n1=7', 'select 7,t.*');
  equivalent('select ? from t limit all\n1=7', 'select 7 from t limit all');
  equivalent('select ? from t offset 2 rows\n1=7', 'select 7 from t offset 2 rows');
  for (const column of ['first', 'next', 'row', 'rows', 'set', 'values', 'by', 'between']) {
    equivalent(`select ?, ${column} from t\n1=7`, `select 7,${column} from t`);
    equivalent(`select ?, ${column}\n1=7`, `select 7,${column}`);
  }
});

test('TRIM direction keywords precede parameters, while qualified columns precede operators', () => {
  for (const direction of ['both', 'leading', 'trailing']) {
    equivalent(`select trim(${direction} ? from name) from t\nparams:\n1=x`, `select trim(${direction} 'x' from name) from t`);
    equivalent(`select t.${direction} ? 'key' from t`);
  }
});

test('non-SQL whitespace reaches the syntax checker without being erased', () => {
  for (const sql of ['\u00a0', '\u3000', '\ufeff', '\v']) {
    const app = createApp();
    assert.equal(app.input(sql), sql);
    assert.equal(app.validation.at(-1).sql, sql);
  }
});

for (const sql of ['values (?)', 'call f(?)', 'explain select ?', 'select ?', '(select ?)']) {
  test(`Hibernate logger retains same-line commands: ${sql}`, () => {
    equivalent(`2026-09-23 DEBUG org.hibernate.SQL : ${sql}\nbinding parameter [1] as [INTEGER] - [7]`, sql.replace('?', '7'));
  });
}

test('expression parentheses format consistently with and without a preceding space', () => {
  for (const [prefix, contents] of [
    ['sum(x) over', 'partition by y order by z rows between 1 preceding and current row'],
    ['extract', 'year from created_at'],
    ['substring', 'name from 2 for 3'],
    ['position', "'a' in name"],
  ]) {
    const spaced = equivalent(`select ${prefix} (${contents}) from t`);
    const compact = equivalent(`select ${prefix}(${contents}) from t`);
    assert.equal(spaced.replace(/\s+\(/g, '('), compact.replace(/\s+\(/g, '('));
    assert.equal(spaced.split('\n').length, 4, spaced);
  }
});
