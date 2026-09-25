import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './helpers/business-app.mjs';

test('IME composition defers conversion and prevents copying a stale SQL result', () => {
  const app = createApp();
  app.input('select 1;');
  const scheduled = app.validation.filter(event => event.kind === 'schedule').length;
  app.dispatch('compositionstart', app.raw);
  app.raw.value = "select '日本';";
  app.dispatch('input', app.raw, { isComposing: true });
  assert.equal(app.copy.disabled, true);
  assert.match(app.node('[data-role="raw-highlight"]').innerHTML, /日本/,
    'the transparent editor needs a current text layer during composition');
  assert.equal(app.validation.filter(event => event.kind === 'schedule').length, scheduled);
  app.dispatch('compositionend', app.raw);
  assert.equal(app.copy.disabled, false);
  assert.match(app.output.value, /日本/);
  const count = app.validation.length;
  app.dispatch('input', app.raw);
  assert.equal(app.validation.length, count, 'the post-composition input event must not re-run conversion');
});

test('composition input without a start event still invalidates the previous result', () => {
  const app = createApp();
  app.input('select 1;');
  app.raw.value = "select '編集中';";
  app.dispatch('input', app.raw, { isComposing: true });
  assert.equal(app.copy.disabled, true);
  assert.match(app.node('[data-role="raw-highlight"]').innerHTML, /編集中/);
  app.dispatch('compositionend', app.raw);
  assert.equal(app.copy.disabled, false);
});

test('unexpected conversion exceptions invalidate the old output and recover on the next edit', async () => {
  const app = createApp({ transformSource: text => text.replace(
    'const _input = _splitInputText(_rawText);',
    'if (_rawText === "fault") throw new Error("injected failure"); const _input = _splitInputText(_rawText);'
  ) });
  app.input('select 1;');
  assert.doesNotThrow(() => app.input('fault'));
  assert.equal(app.copy.disabled, true);
  assert.match(app.output.value, /変換は完了していません/);
  app.click('copy'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.copied.length, 0);
  app.input('select 2;');
  assert.equal(app.copy.disabled, false);
});

test('a formatter regression cannot silently change SQL tokens', () => {
  const app = createApp({ transformSource: text => text.replace(
    '_restoreSqlProtectedSegments(_normalizedOutput, _protectedStore._segments)',
    '"SELECT 99;"'
  ) });
  assert.equal(app.input('select 1;'), 'select 1;');
});

test('returning from back-forward cache restarts validation for the visible input', () => {
  const app = createApp();
  app.input('select 1;');
  const count = app.validation.length;
  app.dispatch('pagehide');
  app.dispatch('pageshow', undefined, { persisted: true });
  assert.ok(app.validation.length > count);
  assert.equal(app.validation.at(-1).kind, 'schedule');
});

test('pasting the same input retries a failed validation', () => {
  const app = createApp();
  app.input('select 1;');
  const count = app.validation.length;
  app.validator.status = 'unavailable';
  app.input('select 1;');
  assert.ok(app.validation.length > count);
});

test('large named-bind sets retain every distinct value', () => {
  const app = createApp();
  const size = 2500;
  const input = `select ${Array.from({ length: size }, (_, i) => `:v${i}`).join(',')}\nparams:\n` +
    Array.from({ length: size }, (_, i) => `v${i} = ${i}`).join('\n');
  const output = app.input(input);
  assert.equal(app.copy.disabled, false);
  assert.deepEqual(output.replace(/^SELECT\s+/i, '').split(',').map(Number), Array.from({ length: size }, (_, i) => i));
});
