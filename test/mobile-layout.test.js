'use strict';
// Mobile QA regressions for the Client App. A real phone audit (test/review/mobile-audit.js: the real index.html +
// app.js against a mock backend, rendered in Electron at 320-820px) found these; this repo has no browser
// dependency, so `npm test` pins their causes:
//   - one long website name made the whole app scroll sideways on a phone (the website switcher <select> is as wide
//     as its longest option) -- and dragged the fixed bottom navigation wider than the screen;
//   - controls were 15-38px tall (saved-website actions, auth tabs, filters, settings tabs...);
//   - text fields under 16px make iOS zoom the page;
//   - the lead drawer used 100vh (its bottom sat behind the phone browser's toolbar).
// And the Saved Websites list at phone width: every Draft/Owned action is a finger-sized control, long names wrap.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const view = require('../saved-websites-view');
const { savedWebsitesFrom } = require('../lib/saved-websites');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
const DS = read('design-system.css');
const APP = read('app.css');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function mediaBlocks(css, re) {
  const out = []; let i = 0;
  while ((i = css.indexOf('@media', i)) !== -1) {
    const open = css.indexOf('{', i); const cond = css.slice(i + 6, open);
    let depth = 1, j = open + 1; while (depth && j < css.length) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
    if (re.test(cond)) out.push(css.slice(open + 1, j - 1));
    i = j;
  }
  return out.join('\n');
}
const TOUCH = mediaBlocks(DS, /max-width:820px\),\(pointer:coarse\)/);

test('the website switcher shrinks with the screen instead of widening the page', () => {
  const select = /body \.site-project-pick select\{([^}]*)\}/.exec(DS)[1];
  assert.match(select, /min-width:0/); assert.match(select, /max-width:100%/); assert.match(select, /text-overflow:ellipsis/);
  assert.match(DS, /body \.site-project-pick label\{[^}]*min-width:0/, 'its label can shrink too');
  assert.match(DS, /body \.site-project-pick\{[^}]*max-width:100%/);
});

test('touch screens: 44px controls, 16px text fields, long words wrap', () => {
  assert.ok(TOUCH.length > 100, 'the touch/phone block exists');
  assert.match(TOUCH, /body :is\(button,select,summary,\.secondary-button,\.primary-action\):not\(\.mobile-nav button\)\{min-height:44px\}/);
  assert.match(TOUCH, /\.saved-website-link[^{]*\{display:inline-flex;align-items:center;min-height:44px\}/, 'saved-website actions are tap targets, not 16px text links');
  assert.match(TOUCH, /:is\(input:not\(\[type=checkbox\]\)[^{]*textarea\)\{font-size:16px!important\}/);
  assert.match(TOUCH, /overflow-wrap:anywhere/);
});

test('the lead drawer fits the visible phone screen (dvh, not vh)', () => {
  assert.match(APP, /\.lead-drawer\{width:100vw;height:100dvh/);
  assert.match(APP, /\.lead-modal\{[^}]*max-height:calc\(100dvh - 24px\);overflow:auto/, 'modals fit and scroll inside');
});

test('the bottom navigation has every customer view and keeps clear of the home indicator', () => {
  const nav = /<nav class="mobile-nav"[\s\S]*?<\/nav>/.exec(HTML)[0];
  for (const v of ['website', 'analytics', 'ads', 'contact', 'settings']) {
    assert.match(nav, new RegExp(`data-view="${v}"`), v);
    assert.match(HTML, new RegExp(`id="view-${v}"`), `${v} view exists`);
  }
  assert.match(APP, /\.mobile-nav\{[^}]*env\(safe-area-inset-bottom\)/);
  assert.match(HTML, /name="viewport" content="width=device-width, initial-scale=1/);
});

test('Saved Websites at phone width: Draft and Owned rows, long names, every action a control the touch rules cover', () => {
  const long = 'Supercalifragilisticexpialidocious-Artisanal-Sourdough-Bakehouse-of-North-Vancouver';
  const list = savedWebsitesFrom([
    { projectId: 'proj_OWNEDaaaaaaaaaaaaaaaaa', name: long, businessName: long, mode: 'business', status: 'purchased', isPurchased: true, purchasedAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z' },
    { projectId: 'proj_DRAFTaaaaaaaaaaaaaaaaa', name: 'A page about kayaks', mode: 'creative', status: 'draft', updatedAt: '2026-09-28T00:00:00Z' },
  ], new Set());
  const html = view.listHtml({ status: 'ready', list });
  assert.equal((html.match(/data-state="owned"/g) || []).length, 1); assert.equal((html.match(/data-state="draft"/g) || []).length, 1);
  // every link in a row is a .saved-website-link (44px on touch); every button is a <button> (44px on touch)
  const links = html.match(/<a [^>]*>/g) || [];
  assert.ok(links.length >= 5 && links.every(a => /class="saved-website-link"/.test(a)), 'no bare text link');
  assert.match(DS, /body \.saved-website-name\{[^}]*overflow-wrap:anywhere/, 'a long name wraps inside its row');
  assert.match(DS, /body \.saved-websites-list\{[^}]*grid-template-columns:repeat\(auto-fill,minmax\(280px,1fr\)\)/);
  assert.match(DS, /@media\(max-width:640px\)\{body \.saved-websites-list\{grid-template-columns:1fr\}/, 'one column on phones');
});
