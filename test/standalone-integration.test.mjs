import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, Script } from 'node:vm';
import { createApp, source } from './helpers/business-app.mjs';

// 配布する3つのスクリプトをまとめて実行する。DOMとWorker間の通信は模擬実装を使い、
// SQL変換・制御処理・転送バイナリ・PostgreSQLのWASMは実物を使う。
function createStandalone() {
  const workers = [];
  const blobs = new Map();
  let urlId = 0;
  const app = createApp({ beforeInit({ context, node }) {
    for (const id of ['postgresql-validator-worker', 'postgresql-validator-wasm']) node(id).textContent = source(id);
    class Worker {
      constructor(url) {
        workers.push(this);
        const blob = blobs.get(url);
        assert.ok(blob);
        this.context = createContext({ WebAssembly, TextEncoder, TextDecoder, URL, performance, console, setTimeout, clearTimeout,
          WorkerGlobalScope: class {},
          self: { location: { href: url }, postMessage: value => {
            if (!this.terminated) this.onmessage({ data: structuredClone(value) });
          } },
          fetch() { throw new Error('Standalone HTML must not access the network'); }
        });
        this.ready = blob.text().then(script => new Script(script).runInContext(this.context));
      }
      postMessage(message, transfer) {
        const data = structuredClone(message, { transfer });
        this.pending = this.ready.then(() => this.terminated ? undefined : this.context.self.onmessage({ data }));
      }
      terminate() { this.terminated = true; }
    }
    Object.assign(context, { Worker, Blob, atob, Uint8Array,
      URL: {
        createObjectURL(blob) { const url = `blob:integration-${++urlId}`; blobs.set(url, blob); return url; },
        revokeObjectURL(url) { blobs.delete(url); }
      },
      getComputedStyle: () => ({ lineHeight: '20px' })
    });
    new Script(source('sql-validation-ui')).runInContext(context);
  } });
  return { app, workers, blobs, async validate(input) {
    const sql = app.input(input);
    app.tick(300);
    await workers.at(-1)?.pending;
    return { sql, status: app.node('[data-role="validation"]').dataset.status };
  } };
}

test('standalone HTML converts, validates offline, and copies exactly the resulting SQL', async () => {
  const tool = createStandalone();
  const result = await tool.validate('select -?, :name\nparams:\n1=-7\nname="日本😀\\r\\nline"');
  assert.equal(result.status, 'checked');
  assert.equal(tool.blobs.size, 0);
  tool.app.click('copy');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(tool.app.copied, [result.sql]);
  assert.equal(tool.app.copy.dataset.copied, 'true');
});

test('standalone parser error, conversion error, and recovery stay synchronized', async () => {
  const tool = createStandalone();
  assert.equal((await tool.validate('SELECT (1;')).status, 'error');
  assert.ok(tool.app.node('[data-role="validation-issues"]').children.length);
  assert.equal((await tool.validate('SELECT 1;')).status, 'checked');
  assert.equal(tool.workers.length, 1, 'healthy idle parser must be reused');
  tool.app.input('select ?\nparams:\ninvalid');
  assert.equal(tool.app.copy.disabled, true);
  assert.equal(tool.workers[0].terminated, true);
  assert.equal((await tool.validate('select ?\nparams:\n1=2')).status, 'checked');
  assert.equal(tool.workers.length, 2);
});

test('clearing during parser startup prevents late results and releases timers', async () => {
  const tool = createStandalone();
  tool.app.input('select 1;'); tool.app.tick(300);
  tool.app.click('clear');
  await tool.workers[0].pending;
  assert.equal(tool.workers[0].terminated, true);
  assert.equal(tool.app.copy.disabled, true);
  assert.equal(tool.app.node('[data-role="validation"]').hidden, true);
  assert.equal(tool.app.timers.size, 0);
  assert.equal((await tool.validate('select 2;')).status, 'checked');
  assert.equal(tool.workers.length, 2, 'a new worker receives intact cached parser bytes');
});

test('format-equivalent input retains the active offline parser', async () => {
  const tool = createStandalone();
  const expected = tool.app.input('select 1;'); tool.app.tick(300);
  assert.equal(tool.app.input('select    1;'), expected);
  assert.equal(tool.workers[0].terminated, undefined);
  await tool.workers[0].pending;
  assert.equal(tool.app.validator.status, 'checked');
  assert.equal((await tool.validate('select\n1;')).status, 'checked');
  assert.equal(tool.workers.length, 1);
  assert.equal(tool.app.timers.size, 0);
});
