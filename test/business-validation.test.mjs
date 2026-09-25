import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createValidationUI } from './helpers/validation-ui.mjs';
import { source } from './helpers/business-app.mjs';

const createUI = () => createValidationUI(source('sql-validation-ui'));

test('only PostgreSQL whitespace skips parsing', () => {
  const ui = createUI();
  ui.controller.schedule(' \t\n\r\f'); ui.tick(300);
  assert.equal(ui.workers.length, 0);
  for (const sql of ['\u00a0', '\u3000', '\ufeff', '\v']) {
    ui.controller.schedule(sql); ui.tick(300);
    const worker = ui.workers.at(-1);
    assert.equal(worker.sent.sql, sql);
    worker.respond('error', [{ message: 'syntax error', offset: 0 }]);
    assert.equal(ui.controller.status, 'error');
  }
});

test('an edit cancels an in-flight parse instead of queuing behind stale work', () => {
  const ui = createUI();
  ui.controller.schedule('SELECT 1'); ui.tick(300);
  const old = ui.workers[0];
  ui.controller.schedule('SELECT 2');
  assert.equal(old.terminated, true);
  ui.tick(300);
  assert.equal(ui.workers.length, 2);
  old.respond('checked');
  assert.equal(ui.get('[data-role="validation"]').dataset.status, 'checking');
  ui.workers[1].respond('checked');
  assert.equal(ui.get('[data-role="validation"]').dataset.status, 'checked');
});

test('a completed worker is reused without retransferring the WASM binary', () => {
  const ui = createUI();
  ui.controller.schedule('SELECT 1'); ui.tick(300);
  const worker = ui.workers[0];
  assert.ok(worker.sent.wasmBinary);
  worker.respond('checked');
  ui.controller.schedule('SELECT 2'); ui.tick(300);
  assert.equal(ui.workers.length, 1);
  assert.equal(worker.sent.wasmBinary, undefined);
});

test('identical SQL preserves pending work and completed diagnostics', () => {
  const ui = createUI();
  ui.controller.schedule('SELECT 1');
  const debounce = [...ui.timers.keys()];
  ui.controller.schedule('SELECT 1');
  assert.deepEqual([...ui.timers.keys()], debounce);
  ui.tick(300);
  const worker = ui.workers[0];
  ui.controller.schedule('SELECT 1');
  assert.equal(worker.terminated, undefined);
  worker.respond('error', [{ message: 'retained diagnostic', offset: 0 }]);
  const item = ui.get('[data-role="validation-issues"]').children[0];
  ui.controller.schedule('SELECT 1');
  assert.equal(ui.get('[data-role="validation-issues"]').children[0], item);
  assert.equal(ui.timers.size, 0);
  ui.controller.reset();
  ui.controller.schedule('SELECT 1'); ui.tick(300);
  assert.equal(ui.workers.length, 2);
});

test('identical SQL retries an unavailable parser', () => {
  const ui = createUI();
  ui.controller.schedule('SELECT 1'); ui.tick(300);
  ui.workers[0].respond('unavailable');
  ui.controller.schedule('SELECT 1'); ui.tick(300);
  assert.equal(ui.workers.length, 2);
  ui.workers[1].respond('checked');
  assert.equal(ui.controller.status, 'checked');
});

test('malformed worker responses fail safely and can be retried', () => {
  for (const data of [null, {}, { status: 'error' }, { status: 'error', issues: [{}] }, { status: 'error', issues: [] }]) {
    const ui = createUI();
    ui.controller.schedule('SELECT 1'); ui.tick(300);
    const worker = ui.workers[0];
    worker.onmessage({ data: data && { id: worker.sent.id, ...data } });
    assert.equal(worker.terminated, true);
    assert.equal(ui.get('[data-role="validation"]').dataset.status, 'unavailable');
    ui.controller.schedule('SELECT 2'); ui.tick(300);
    ui.workers[1].respond('checked');
    assert.equal(ui.get('[data-role="validation"]').dataset.status, 'checked');
  }
});

test('pagehide releases parser and timers; message decoding errors are recoverable', () => {
  const ui = createUI();
  ui.controller.schedule('SELECT 1'); ui.tick(300);
  const worker = ui.workers[0];
  worker.onmessageerror();
  assert.equal(worker.terminated, true);
  ui.controller.schedule('SELECT 2'); ui.tick(300);
  ui.window.pagehide();
  assert.equal(ui.workers[1].terminated, true);
  assert.equal(ui.timers.size, 0);
});

test('a success response carrying errors cannot be reported as checked', () => {
  const ui = createUI();
  ui.controller.schedule('SELECT 1'); ui.tick(300);
  ui.workers[0].respond('checked', [{ message: 'inconsistent result', offset: 0 }]);
  assert.equal(ui.get('[data-role="validation"]').dataset.status, 'unavailable');
});

test('unsolicited malformed messages from an idle worker do not invalidate checked SQL', () => {
  const ui = createUI();
  ui.controller.schedule('SELECT 1'); ui.tick(300);
  ui.workers[0].respond('checked');
  ui.workers[0].onmessage({ data: null });
  assert.equal(ui.get('[data-role="validation"]').dataset.status, 'checked');
});
