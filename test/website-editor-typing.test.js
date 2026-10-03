'use strict';
// WHAT THE OWNER IS TYPING SURVIVES: the Creative editor (website-creative-editor.js, the real file) redraws itself on a job
// poll, on the app's own render of the Website view, on a credit update, on every busy / quote state -- and a field drawn
// again with innerHTML is a NEW field, its value whatever the markup says. Before this fix the scene's AI instruction, the
// whole-page direction and the open text box came back empty (or as the saved words) mid-sentence.
// The page around the editor is a small DOM stand-in that behaves the way the browser does where it matters here:
// assigning innerHTML replaces the fields inside (their typed values, focus and caret gone); the fetches are the app's
// routes, answered by the test; timers are run by the test (a job poll is "3 seconds later", on demand).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = process.env.EDITOR_SRC || path.join(__dirname, '..', 'website-creative-editor.js');
const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const camel = k => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function page() {
  const doc = { activeElement: null, readyState: 'complete' };
  class El {
    constructor(tag, attrs, inner) {
      this.tagName = tag.toUpperCase(); this.attrs = attrs || {}; this.id = this.attrs.id || ''; this.dataset = {}; this.parent = null;
      Object.keys(this.attrs).forEach(k => { if (k.startsWith('data-')) this.dataset[camel(k.slice(5))] = this.attrs[k]; });
      this.value = tag === 'textarea' ? unesc(inner || '') : (this.attrs.value != null ? unesc(this.attrs.value) : '');
      this.disabled = 'disabled' in this.attrs; this.kids = []; this._html = ''; this.textContent = ''; this.className = this.attrs.class || ''; this.hidden = false;
      this.selectionStart = 0; this.selectionEnd = 0; this.selectionDirection = 'none'; this.scrollTop = 0; this.listeners = {};
    }
    get innerHTML() { return this._html; }
    // the browser: the old fields are gone (with what was typed into them); the new ones hold what the markup says
    set innerHTML(html) {
      if (doc.activeElement && this.contains(doc.activeElement)) doc.activeElement = null;
      this._html = html; this.kids = []; const re = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>|<(input|button|select)\b([^>]*)>/g; let m;
      while ((m = re.exec(html))) { const tag = m[3] || 'textarea'; const attrs = {}; (m[1] != null ? m[1] : m[4]).replace(/([\w-]+)(?:="([^"]*)")?/g, (_, k, v) => { attrs[k] = v == null ? '' : v; return ''; }); const el = new El(tag, attrs, m[2]); el.parent = this; this.kids.push(el); }
      this.writes = (this.writes || 0) + 1;
    }
    get childNodes() { return this._html ? [1] : []; }
    all() { return this.kids.concat(...this.kids.map(k => k.all())); }
    contains(el) { return el === this || this.all().includes(el) || (this.parts || []).some(p => p.contains(el)); }
    querySelectorAll(sel) {
      const els = [].concat(this.all(), ...(this.parts || []).map(p => p.all()));
      if (sel === '[data-draft]') return els.filter(e => e.dataset.draft != null);
      if (sel === 'button,select,input,textarea') return els.filter(e => ['BUTTON', 'SELECT', 'INPUT', 'TEXTAREA'].includes(e.tagName));
      throw new Error('selector not modelled: ' + sel);
    }
    hasAttribute(k) { return k in this.attrs; }
    closest(sel) { return sel === '[data-ce]' && this.dataset.ce ? this : null; }
    focus() { doc.activeElement = this; }
    setSelectionRange(a, b, d) { this.selectionStart = a; this.selectionEnd = b; this.selectionDirection = d; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  }
  const box = new El('section', { id: 'creativeEditor' }); const parts = ['ceScenes', 'cePanel', 'ceWhole'].map(id => new El('div', { id }));
  box.parts = parts; const fixed = { creativeEditor: box, creativeEditorPill: new El('span', { id: 'creativeEditorPill' }), ceFeedback: new El('p', { id: 'ceFeedback' }), siteEditor: new El('div', { id: 'siteEditor' }) };
  parts.forEach(p => { fixed[p.id] = p; });
  doc.querySelector = sel => { if (!sel.startsWith('#')) throw new Error('selector not modelled: ' + sel); const id = sel.slice(1); return fixed[id] || [].concat(...parts.map(p => p.all())).find(e => e.id === id) || null; };
  doc.addEventListener = () => {};
  return { doc, box, parts, fire: (type, el) => (box.listeners[type] || []).forEach(fn => fn({ target: el })) };
}

const OUTLINE = () => ({ kind: 'creative', palette: [{ role: 'primary', label: 'Brand', hex: '#cc0000' }], pictures: [], models: [], media: [], threeDCompositions: [], actions: ['reapply-look', 'ai-site'],
  scenes: ['opening', 'scene-2'].map((id, i) => ({ id, index: i, name: id === 'opening' ? 'Kolaro' : 'Second', composition: 'object-stage', background: '#ffffff', text: { kicker: '', heading: id === 'opening' ? 'Kolaro' : 'Second', body: 'Saved paragraph', items: [] }, pictures: [], models: [], compositions: [], actions: ['text', 'text-layout', 'colour', 'composition', 'ai-text', 'ai-scene'] })) });

async function editor() {
  const P = page(); const timers = []; const calls = [];
  let jobs = [{ jobId: 'j1', kind: 'motion', status: 'running', terminal: false, message: 'Creating cinematic clip…' }];
  const reply = (status, body) => ({ status, ok: status < 400, json: async () => body });
  const ctx = {
    document: P.doc, console, Promise, Object, Array, JSON, Number, String, Math, Error, RegExp,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
    fetch: async (url, o) => { calls.push([o && o.method, url, o && o.body && JSON.parse(o.body)]);
      if (/\/creative$/.test(url)) return reply(200, { ok: true, revision: 7, outline: OUTLINE(), jobs, creditsRemaining: 40 });
      if (/\/creative\/jobs$/.test(url)) return reply(200, { ok: true, revision: 7, jobs });
      if (/\/creative\/quote$/.test(url)) return reply(200, { ok: true, quote: { id: 'q1', credits: 2, items: [{ label: 'x', credits: 2 }] }, enough: true });
      if (/\/creative\/edit$/.test(url)) return reply(422, { ok: false, code: 'edit_failed', message: 'Not now.' });
      return reply(404, { ok: false }); },
    canonicalWebsite: { status: 'ready', project: { projectId: 'proj_1', revision: 7, kind: 'creative' } },
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx);
  const E = ctx.window.CreativeEditor; const settle = () => new Promise(r => setImmediate(r));
  E.render(ctx.canonicalWebsite.project); for (let i = 0; i < 6; i++) await settle();
  const $ = sel => P.doc.querySelector(sel);
  const btn = (ce, extra) => [].concat(...P.parts.map(p => p.all())).find(e => e.dataset.ce === ce && (!extra || Object.keys(extra).every(k => e.dataset[k] === extra[k])));
  const type = (el, text) => { el.focus(); el.value = text; el.setSelectionRange(text.length - 3, text.length - 3, 'forward'); P.fire('input', el); };
  const click = el => P.fire('click', el);
  // every way the editor is drawn again without the owner asking for it
  const redraws = {
    'the app renders the Website view again': async () => { E.render(ctx.canonicalWebsite.project); for (let i = 0; i < 4; i++) await settle(); },
    'a job poll (nothing changed)': async () => { const t = timers.splice(0).pop(); if (t) t.fn(); for (let i = 0; i < 4; i++) await settle(); },
    'a job poll (its progress changed: the panel is drawn again)': async () => { jobs = [{ jobId: 'j1', kind: 'motion', status: 'running', terminal: false, message: 'Still creating… ' + Math.random() }]; const t = timers.splice(0).pop(); if (t) t.fn(); for (let i = 0; i < 4; i++) await settle(); },
    'the editor reloads its outline': async () => { await E.reload(); for (let i = 0; i < 2; i++) await settle(); },
    'a quote is asked for (busy, then the cost shown)': async () => { click(btn('ai-scene')); for (let i = 0; i < 6; i++) await settle(); if (!btn('cancel')) throw new Error('no cost shown: ' + JSON.stringify({ busy: E._state.busy, pending: !!E._state.pending, msg: E._state.msg, calls: calls.slice(-3).map(c => c[1]) })); click(btn('cancel')); await settle(); },
    'a free change fails': async () => { click(btn('colour')); for (let i = 0; i < 4; i++) await settle(); },
  };
  return { P, E, $, btn, type, click, redraws, calls, settle, state: E._state };
}

test('the owner\'s words survive every redraw: the open text box, the scene\'s AI instruction and the whole-page direction -- the text, and the caret of the field being typed in', async () => {
  const w = await editor();
  // the open text box
  w.click(w.btn('open', { key: 'text:heading' })); await w.settle();
  const fields = [['#ceText', 'A headline the owner is still typ'], ['#ceSceneAsk', 'Make the bottle feel colder and closer, like a fridge door open'], ['#ceSiteAsk', 'A bolder summer page with more red and less white space']];
  for (const [sel, words] of fields) {
    w.type(w.$(sel), words);
    for (const [why, redraw] of Object.entries(w.redraws)) {
      await redraw();
      const el = w.$(sel); assert.ok(el, `${sel} after ${why}`);
      assert.equal(el.value, words, `${sel}: the typed words after ${why}`);
    }
    // a field drawn again gives the caret back where it was
    const el = w.$(sel); w.P.doc.activeElement = el; el.setSelectionRange(5, 9, 'forward');
    await w.redraws['a job poll (its progress changed: the panel is drawn again)']();
    const back = w.$(sel); assert.equal(w.P.doc.activeElement, back, `${sel}: still the field being typed in`); assert.deepEqual([back.selectionStart, back.selectionEnd], [5, 9]);
  }
  // all three at once, through one more round of every redraw
  for (const redraw of Object.values(w.redraws)) await redraw();
  fields.forEach(([sel, words]) => assert.equal(w.$(sel).value, words, sel));
});

test('a redraw that changes nothing leaves the fields alone (no new field at all); the words are given back only when the markup really changed', async () => {
  const w = await editor(); const panel = w.P.parts[1]; const whole = w.P.parts[2];
  w.type(w.$('#ceSiteAsk'), 'Typed and kept'); const el = w.$('#ceSiteAsk'); const writes = [panel.writes, whole.writes];
  await w.redraws['the app renders the Website view again'](); await w.redraws['a job poll (nothing changed)']();
  assert.equal(w.$('#ceSiteAsk'), el, 'the very same field'); assert.deepEqual([panel.writes, whole.writes], writes, 'not drawn again');
});

test('the words are let go only when the owner is done with them: Cancel, switching scene (the whole-page words stay), another website -- and never stored in the browser', async () => {
  const w = await editor();
  w.click(w.btn('open', { key: 'text:heading' })); await w.settle(); w.type(w.$('#ceText'), 'Not saved yet');
  w.click(w.btn('close')); await w.settle();
  w.click(w.btn('open', { key: 'text:heading' })); await w.settle(); assert.equal(w.$('#ceText').value, 'Kolaro', 'Cancel let the unsaved words go: the saved words again');
  w.type(w.$('#ceSceneAsk'), 'for the opening scene'); w.type(w.$('#ceSiteAsk'), 'for the whole page');
  w.click(w.btn('scene', { scene: 'scene-2' })); await w.settle();
  assert.equal(w.$('#ceSceneAsk').value, '', 'another scene: its own empty instruction'); assert.equal(w.$('#ceSiteAsk').value, 'for the whole page', 'the whole-page words stay');
  w.click(w.btn('scene', { scene: 'opening' })); await w.settle(); assert.equal(w.$('#ceSceneAsk').value, '', 'leaving a scene let its instruction go');
  // while a change is on its way the actions wait -- the fields being typed in never do
  w.state.busy = true; w.E.render({ projectId: 'proj_1', revision: 7, kind: 'creative' }); await w.settle();
  assert.equal(w.$('#ceSiteAsk').disabled, false); assert.equal(w.btn('ai-site').disabled, true); w.state.busy = false;
  // another website: nothing carries over
  w.E.render({ projectId: 'proj_2', revision: 1, kind: 'creative' }); await w.settle(); assert.deepEqual(Object.keys(w.state.drafts), []);
  assert.doesNotMatch(fs.readFileSync(SRC, 'utf8'), /localStorage|sessionStorage/, 'never in storage');
});
