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
  const actual = app.input(input);
  assert.equal(app.copy.disabled, false, actual);
  assert.deepEqual(ast(actual), reference, actual);
  return actual;
}

const statements = [
  "select null ? 'key', true ? 'key', false ? 'key';",
  'select data ? キー from t;',
  'select t.params from t;',
  'select 1 as int, 2 as numeric;',
  'select 1.0::numeric(10,2), 1.e3, 1e-8;',
  "select interval '1' year to month, date '2026-09-22';",
  'select coalesce(a,b), greatest(a,b), nullif(a,b) from t;',
  'select percentile_cont(0.5) within group (order by amount) from t;',
  'select sum(x) filter(where x>0) over(partition by y order by z) from t;',
  'select * from t tablesample bernoulli(10) repeatable(1);',
  'select x from t group by grouping sets ((x),());',
  'select x from t union (select y from u order by y limit 1);',
  "select jsonb_build_object('select',1,'from',2), row(1,2);",
  'select a between symmetric 1 and 2, a not in (1,2), a is not distinct from b from t;',
  'select * from t natural left join u;',
  'select * from t join u using(id);',
  "select trim(both 'x' from a), substring(a from 2 for 3), position('x' in a) from t;",
  'with recursive x(n) as (values(1) union all select n+1 from x where n<10) select * from x;',
  'delete from t using u where t.id=u.id returning t.*;',
  'create table t(id int generated always as identity, x text default \'x\');',
  'create function f() returns int language sql as $$ select 1; $$;',
  'do $body$ begin raise notice \'params: ? :x\'; end $body$;',
  'begin; savepoint s; select 1; rollback to s; commit;',
  'select \'one\' as "FROM", \'two\' as "select";',
  'select /* outer /* inner */ end */ 1 -- end\n;',
  "select N'hello', E'a\\\'b', U&'\\0061', B'0101', X'beef';",
  'select (ARRAY[ARRAY[1,2], ARRAY[3,4]])[1:2];',
  'select CURRENT_TIMESTAMP(3), localtimestamp(2), extract(epoch from now());',
];
for (const sql of statements) test(`additional SQL fidelity: ${JSON.stringify(sql)}`, () => equivalent(sql));

test('deterministic whitespace corpus preserves AST and formatting is idempotent', () => {
  const templates = statements.filter(sql => !sql.includes("'") && !sql.includes('--') && !sql.includes('/*'));
  for (const sql of templates) for (const whitespace of ['\n', '\t', '\r\n', '   ']) {
    const variant = sql.replaceAll(' ', whitespace);
    const output = equivalent(variant);
    const app = createApp();
    assert.equal(app.input(output), output, variant);
  }
});

test('qualified SQL keyword identifiers are never mistaken for clauses', () => {
  for (const name of ['SELECT', 'FROM', 'WHERE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'GROUP', 'ORDER', 'LIMIT', 'ON', 'AND', 'OR', 'JOIN']) {
    equivalent(`select t.${name}, count(t.${name}) from t;`);
  }
});

test('prefixed literal continuation retains its mandatory newline', () => {
  for (const prefix of ['E', 'N', 'B', 'X']) equivalent(`select ${prefix}'01'\n'01';`);
});

test('seeded nested-expression corpus preserves parser trees', () => {
  let seed = 442;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  function expression(depth) {
    if (!depth) return ['1', '2', 'NULL', 't.x'][random(4)];
    const a = expression(depth - 1), b = expression(depth - 1);
    return [`(${a}+${b})`, `coalesce(${a},${b})`, `case when ${a} is null then ${b} else ${a} end`, `(select ${a})`, `(${a}::numeric)`][random(5)];
  }
  for (let i = 0; i < 160; i++) equivalent(`select ${expression(3)} as value from t where t.id between 1 and 9 order by t.id desc;`);
});

const bindings = [
  ['select -?, 1-?\nparams:\n1 = -1\n2 = -2', 'select -(-1),1-(-2)'],
  ['select -:x, 1-:y\nparams:\nx = -1\ny = -2', 'select -(-1),1-(-2)'],
  ["select ?, :x\nparams:\n1 = E'a\\nb'\nx = $$hello 'world'$$", "select E'a\\nb', $$hello 'world'$$"],
  ["select ?\nparams:\n1 = 'line1\nline2'", "select 'line1\nline2'"],
  ["select ?\nparams:\n1 = \"line1\\nline2\"", "select E'line1\\nline2'"],
  ['sql=[select $$] params=[x]$$, ?] params=[1 = 7]', 'select $$] params=[x]$$,7'],
  ['sql=[select ?] params=[1 = ]', "select ''"],
  ['select ?\nparams:\n1 = ', "select ''"],
  ['select :x, :x\nparams:\nx = 7', 'select 7,7'],
];
for (const [input, expected] of bindings) test(`additional bind fidelity: ${JSON.stringify(input)}`, () => equivalent(input, expected));

test('invalid parameter entries cannot disappear silently', () => {
  for (const input of ['sql=[select ?] params=[1=7, invalid entry]', 'select ?\nparams:\n1=7\ninvalid entry']) {
    const app = createApp(); app.input(input);
    assert.equal(app.copy.disabled, true, app.output.value);
  }
});

test('a quoted parameter cannot add executable SQL outside its literal', () => {
  const value = "'a'; delete from t; 'b'";
  equivalent(`select ?\nparams:\n1=${value}`, `select '${value.replaceAll("'", "''")}'`);
});
