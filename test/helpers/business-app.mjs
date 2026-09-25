import { readFileSync } from 'node:fs';
import { createContext, Script } from 'node:vm';

export const html = readFileSync(new URL('../../bind-sql-for-eclipse-postgresql.html', import.meta.url), 'utf8');
export const source = id => html.match(new RegExp(`<script id="${id}"[^>]*>([^]*?)</script>`))[1];

// Run the shipped script, including initialization and document event handlers.
// Browser services are deterministic substitutes; this is not a browser layout test.
export function createApp({ clipboard, fallback = true, storage, transformSource = value => value, beforeInit } = {}) {
  const listeners = new Map();
  const timers = new Map();
  let timerId = 0;
  let document;
  class Element {
    constructor(selector = '') {
      Object.assign(this, { selector, dataset: {}, style: {}, attributes: new Map(),
        value: '', textContent: '', innerHTML: '', isConnected: true, disabled: false,
        selectionStart: 0, selectionEnd: 0, scrollTop: 0, scrollLeft: 0, children: [] });
      const classes = new Set();
      this.classList = { add: name => classes.add(name), remove: name => classes.delete(name) };
      const action = /data-action="([^"]+)"/.exec(selector)?.[1];
      if (action) this.attributes.set('data-action', action);
    }
    matches(selector) { return this.selector === selector; }
    closest() { return this.attributes.has('data-action') ? this : null; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    getAttribute(name) { return this.attributes.get(name); }
    addEventListener(name, handler) { this[name] = handler; }
    focus() { document.activeElement = this; }
    select() { this.focus(); this.selectionStart = 0; this.selectionEnd = this.value.length; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    remove() { this.isConnected = false; }
    replaceChildren(...nodes) { this.children = nodes; }
    append(...nodes) { this.children.push(...nodes); }
  }
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, new Element(selector));
    return nodes.get(selector);
  };
  const copied = [];
  const validation = [];
  const addEventListener = (name, handler) => {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(handler);
  };
  document = {
    querySelector: node, querySelectorAll: () => [], getElementById: node, documentElement: new Element(),
    addEventListener, createElement: () => new Element(), createTextNode: text => ({ textContent: text }), body: { append() {} },
    execCommand() { if (fallback) copied.push(document.activeElement.value); return fallback; }
  };
  const window = {
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: id => timers.delete(id), addEventListener,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    localStorage: storage ?? { getItem() { return null; }, setItem() {} },
    BindSQLValidation: {
      reset: message => validation.push({ kind: 'reset', message }),
      schedule: sql => validation.push({ kind: 'schedule', sql })
    }
  };
  const context = createContext({ document, window, HTMLElement: Element, Element,
    navigator: { clipboard: clipboard ?? { async writeText(value) { copied.push(value); } } }, console });
  beforeInit?.({ context, window, document, node });
  new Script(transformSource(source('bindsql-app'))).runInContext(context);
  const dispatch = (name, target, properties = {}) => {
    for (const listener of listeners.get(name) ?? []) listener({ target, ...properties });
  };
  const raw = node('[data-role="raw-input"]');
  const output = node('[data-role="output"]');
  const copy = node('[data-action="copy"]');
  return {
    node, document, raw, output, copy, copied, validation, dispatch, timers, validator: window.BindSQLValidation,
    input(text) { raw.value = text; dispatch('input', raw); return output.value; },
    click(action) { dispatch('click', node(`[data-action="${action}"]`)); },
    tick(delay) {
      for (const [id, timer] of [...timers]) if (timer.delay === delay) {
        timers.delete(id); timer.callback();
      }
    }
  };
}
