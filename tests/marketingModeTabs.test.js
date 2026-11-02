'use strict';

// The Modes page's tabs (marketing/modes.html + marketing/script.js) follow
// the WAI-ARIA tabs pattern: the selected tab is the tablist's only Tab stop
// (roving tabindex), Left/Right move to the previous/next tab and wrap,
// Home/End jump to the first/last, and the tab that gets focus is selected.
// script.js runs here against a small stand-in for the DOM, built from the
// page's own tab and panel tags, so the markup's starting state is tested
// too. (The real-browser check is a headless-Chrome run; see the PR.)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SITE = path.join(__dirname, '..', 'marketing');
const html = fs.readFileSync(path.join(SITE, 'modes.html'), 'utf8');
const script = fs.readFileSync(path.join(SITE, 'script.js'), 'utf8');

const attrsOf = (tag) => {
  const a = {};
  for (const m of tag.matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) if (m[1] !== tag.slice(1).split(/\s/)[0]) a[m[1]] = m[2] ?? '';
  return a;
};
const tabTags = [...html.matchAll(/<button\b[^>]*\brole="tab"[^>]*>/g)].map((m) => attrsOf(m[0]));
const panelTags = [...html.matchAll(/<div\b[^>]*\bdata-mode-panel="[^"]+"[^>]*>/g)].map((m) => attrsOf(m[0]));

function page() {
  const doc = { activeElement: null };
  class El {
    constructor(attrs, isButton) {
      this.attrs = { ...attrs };
      this.isButton = isButton;
      this.listeners = {};
      this.hidden = 'hidden' in attrs;
      const classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
      this.classList = { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) };
      this.dataset = {};
      for (const [k, v] of Object.entries(attrs)) {
        if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
      }
    }
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
    setAttribute(n, v) { this.attrs[n] = String(v); }
    get tabIndex() { return 'tabindex' in this.attrs ? Number(this.attrs.tabindex) : (this.isButton ? 0 : -1); }
    set tabIndex(v) { this.attrs.tabindex = String(v); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    focus() { doc.activeElement = this; }
    fire(type, props = {}) {
      const e = { key: undefined, ...props, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      (this.listeners[type] || []).forEach((fn) => fn(e));
      return e;
    }
  }
  const tabs = tabTags.map((a) => new El(a, true));
  const panels = panelTags.map((a) => new El(a, false));
  Object.assign(doc, {
    querySelectorAll: (sel) => ({ '.mode-pill[data-mode]': tabs, '[data-mode-panel]': panels })[sel] || [],
    querySelector: () => null,
    getElementById: () => null,
    addEventListener: () => {},
  });
  vm.runInNewContext(script, { document: doc, window: { innerHeight: 900 } });
  const state = () => ({
    focus: doc.activeElement ? doc.activeElement.dataset.mode : null,
    selected: tabs.filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.dataset.mode),
    tabStops: tabs.filter((t) => t.tabIndex === 0).map((t) => t.dataset.mode),
    shown: [...new Set(panels.filter((p) => !p.hidden).map((p) => p.dataset.modePanel))],
  });
  const key = (k) => doc.activeElement.fire('keydown', { key: k });
  return { tabs, panels, state, key, doc };
}

test('modes.html: three tabs, and the selected one is the only Tab stop before any script runs', () => {
  assert.deepEqual(tabTags.map((a) => a['data-mode']), ['socratic', 'debate', 'discussion']);
  const stops = tabTags.filter((a) => a.tabindex !== '-1');
  assert.deepEqual(stops.map((a) => a['aria-selected']), ['true'], 'only the selected tab may lack tabindex="-1"');
  for (const a of panelTags.filter((p) => p.role === 'tabpanel')) {
    assert.equal(a.tabindex, '0', `${a.id}: a tab panel with nothing focusable inside is the next Tab stop (tabindex="0")`);
  }
});

test('script.js: one Tab stop that follows the selection', () => {
  const p = page();
  assert.deepEqual(p.state(), { focus: null, selected: ['socratic'], tabStops: ['socratic'], shown: ['socratic'] });
  p.tabs[0].focus();
  p.key('ArrowRight');
  assert.deepEqual(p.state(), { focus: 'debate', selected: ['debate'], tabStops: ['debate'], shown: ['debate'] });
});

test('script.js: Left/Right wrap, Home/End jump to the ends', () => {
  const p = page();
  p.tabs[0].focus();
  const moves = [['End', 'discussion'], ['Home', 'socratic'], ['ArrowLeft', 'discussion'], ['ArrowRight', 'socratic'],
    ['ArrowRight', 'debate'], ['End', 'discussion'], ['End', 'discussion'], ['ArrowRight', 'socratic'], ['Home', 'socratic']];
  for (const [k, mode] of moves) {
    const e = p.key(k);
    assert.equal(e.defaultPrevented, true, `${k} should not also scroll the page`);
    assert.deepEqual(p.state(), { focus: mode, selected: [mode], tabStops: [mode], shown: [mode] }, `after ${k}`);
  }
});

test('script.js: other keys are left alone, and a click still selects', () => {
  const p = page();
  p.tabs[0].focus();
  for (const k of ['Tab', 'Enter', ' ', 'ArrowDown', 'ArrowUp', 'a']) {
    assert.equal(p.key(k).defaultPrevented, false, `${JSON.stringify(k)} must keep its default`);
  }
  assert.deepEqual(p.state().selected, ['socratic']);
  p.tabs[2].fire('click');
  assert.deepEqual(p.state(), { focus: 'socratic', selected: ['discussion'], tabStops: ['discussion'], shown: ['discussion'] });
});
