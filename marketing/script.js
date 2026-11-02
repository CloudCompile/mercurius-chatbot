/**
 * Mercurius AI — marketing site
 *
 * Deliberately minimal. The page works without JS — the mode tabs
 * stay on "Socratic" (the default panel is the only one not hidden)
 * and the phone menu is a native <details>. This script wires up the
 * tab switching, a few menu niceties, holding the hero's entrance until
 * it is on screen, and a tiny dynamic year in the footer. (Reel players
 * live in ads.js, the lesson replay in demo.js.)
 *
 * No frameworks, no dependencies. Loaded `defer` so it never blocks
 * parse.
 */

(() => {
  'use strict';

  // ---- Mode tabs (Socratic / Debate / Discussion) ----
  //
  // Tabs and panels are decoupled via `data-mode-panel`. Any element on
  // the page that wants to react to a mode change (the description
  // panel, the "Mode by intent" stage, anything we add later) tags
  // itself with `data-mode-panel="<mode>"` and gets toggled in one pass.
  const tabs = Array.from(document.querySelectorAll('.mode-pill[data-mode]'));
  const panels = Array.from(document.querySelectorAll('[data-mode-panel]'));

  if (tabs.length && panels.length) {
    // The selected tab is the tablist's only Tab stop (roving tabindex);
    // the others are reached with the arrow keys.
    const activate = (mode) => {
      tabs.forEach((t) => {
        const on = t.dataset.mode === mode;
        t.classList.toggle('is-active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
      });
      panels.forEach((p) => {
        const on = p.dataset.modePanel === mode;
        p.hidden = !on;
        p.classList.toggle('is-active', on);
      });
    };
    const selected = tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0];
    activate(selected.dataset.mode);

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => activate(tab.dataset.mode));
      // WAI-ARIA tabs keyboard pattern: Left/Right move to the previous or
      // next tab (wrapping), Home/End to the first or last, and the tab
      // that gets focus is selected straight away.
      tab.addEventListener('keydown', (e) => {
        const i = tabs.indexOf(tab);
        const n = tabs.length;
        const to = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        tabs[to].focus();
        activate(tabs[to].dataset.mode);
      });
    });
  }

  // ---- Phone/tablet menu ----
  //
  // The menu is a native <details>, so it opens and closes without JS.
  // This only adds the expected extras: Escape closes it (and returns
  // focus to "Menu"), and so do a click outside it or on one of its links,
  // and Tabbing out of it.
  document.querySelectorAll('[data-nav-menu]').forEach((menu) => {
    const summary = menu.querySelector('summary');
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && menu.open) {
        menu.open = false;
        if (summary) summary.focus();
      }
    });
    document.addEventListener('click', (e) => {
      if (menu.open && !menu.contains(e.target)) menu.open = false;
    });
    menu.addEventListener('click', (e) => {
      if (e.target.closest('a')) menu.open = false;
    });
    // Close it when keyboard focus leaves it, so the open panel never
    // covers the next focused link (WCAG 2.4.7).
    menu.addEventListener('focusout', (e) => {
      if (menu.open && e.relatedTarget && !menu.contains(e.relatedTarget)) menu.open = false;
    });
  });

  // ---- Hero entrance ----
  //
  // Merc's idle and the hero exchange play once (styles.css). On a phone
  // the hero art starts below the fold, so hold them (`is-waiting` pauses
  // them) until it scrolls into view. Without JS they play on load.
  const art = document.querySelector('.hero-art');
  if (art && 'IntersectionObserver' in window && art.getBoundingClientRect().top >= window.innerHeight) {
    art.classList.add('is-waiting');
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      art.classList.remove('is-waiting');
      seen.disconnect();
    }, { threshold: 0.2 });
    seen.observe(art);
  }

  // ---- Dynamic year ----
  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());
})();
