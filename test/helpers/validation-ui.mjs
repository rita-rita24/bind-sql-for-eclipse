import { createContext, Script } from 'node:vm';

// A small DOM/Worker boundary exercises the shipped UI controller unchanged.
export function createValidationUI(script) {
  class Element {
    constructor() { this.dataset = {}; this.attributes = {}; this.children = []; this.textContent = ''; }
    setAttribute(key, value) { this.attributes[key] = value; }
    replaceChildren() { this.children = []; }
    append(...nodes) { this.children.push(...nodes); }
    addEventListener(type, callback) { this[type] = callback; }
    focus() { this.focused = true; }
    setSelectionRange(start, end) { this.selection = [start, end]; }
  }
  const elements = new Map();
  const get = selector => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const timers = new Map();
  let timerId = 0;
  const workers = [];
  class Worker {
    constructor() { workers.push(this); }
    postMessage(message) { this.sent = message; }
    terminate() { this.terminated = true; }
    respond(status, issues = [], id = this.sent.id) { this.onmessage({ data: { id, status, issues } }); }
  }
  const window = {
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(name, handler) { this[name] = handler; }
  };
  const document = {
    querySelector: get, getElementById: get,
    createElement: () => new Element(), createTextNode: text => ({ textContent: text })
  };
  const context = createContext({
    window, document, Worker, Blob, atob, Uint8Array,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    getComputedStyle: () => ({ lineHeight: '20px' })
  });
  new Script(script).runInContext(context);
  const tick = delay => {
    for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); }
  };
  return { controller: window.BindSQLValidation, get, workers, tick, window, timers };
}

