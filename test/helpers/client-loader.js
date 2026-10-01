'use strict';
// A brand-new browser tab of the Client App, for the cold-start tests: the REAL website functions of app.js
// (loadCanonicalWebsite, loadSavedWebsites, loadWebsiteProjectsList, switchToWebsiteProject, websiteSnapshot and what
// they call), cut out of app.js by name and run in a fresh vm context. The page around them is stubbed: rendering is a
// no-op, `fetch` goes to the test's app server as the signed-in test person, localStorage is an in-memory store
// (empty unless the test says otherwise -- "no useful localStorage"), and website-selection.js is the real file.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8').replace(/\r\n/g, '\n');

function cutFunction(name) {
  const m = new RegExp(`(^|\\n)((?:async )?function ${name}\\()`).exec(APP);
  if (!m) return ''; // (a helper an older app.js doesn't have -- lets these tests run against it and show what it got wrong)
  const start = m.index + m[1].length; let i = APP.indexOf('{', start), depth = 0;
  for (; i < APP.length; i++) { const ch = APP[i]; if (ch === '{') depth++; else if (ch === '}' && --depth === 0) break; }
  return APP.slice(start, i + 1);
}
function cutConst(name) {
  const m = new RegExp(`\\nconst ${name}=[^\\n]*`).exec(APP);
  if (!m) throw new Error(`app.js has no const ${name}`);
  return m[0].trim();
}
const CONSTS = ['canonicalWebsite', 'multiProject', 'websiteCandidates', 'savedWebsites', 'websiteView'];
const FUNCTIONS = ['loadCanonicalWebsite', 'fetchWebsiteSummary', 'websiteSummaryReady', 'websiteSelectionStorage', 'syncWebsiteSelection', 'rememberWebsiteSelection',
  'loadWebsiteProjectsList', 'loadWebsiteCandidates', 'loadSavedWebsites', 'switchToWebsiteProject', 'safeSiteUrl', 'siteHost', 'deliveryProjects', 'currentDeliveryProject', 'websiteSnapshot'];
const SOURCE = CONSTS.map(cutConst).join('\n') + '\n' + FUNCTIONS.map(cutFunction).join('\n') +
  '\n;globalThis.__app={canonicalWebsite,multiProject,savedWebsites,websiteView,loadCanonicalWebsite,loadSavedWebsites,loadWebsiteProjectsList,switchToWebsiteProject,websiteSnapshot};';

function memoryStorage(initial) {
  const m = new Map(Object.entries(initial || {}));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), dump: () => Object.fromEntries(m) };
}

// opts: { base (app server origin), as (test person), workspaceId, storage, websiteProjects (delivery records) }
function openTab({ base, as, workspaceId, storage, websiteProjects }) {
  const requests = [];
  const ctx = {
    console, URL, URLSearchParams, Date, JSON, Promise, encodeURIComponent, decodeURIComponent, setTimeout,
    fetch: async (url, opts) => { requests.push(String(url)); return fetch(base + url, Object.assign({}, opts, { headers: Object.assign({}, (opts && opts.headers) || {}, { 'x-test-as': as }) })); },
    state: { user: { id: as }, workspace: { id: workspaceId }, websiteProjects: websiteProjects || [] },
    window: { WebsiteSelection: require(path.join(ROOT, 'website-selection.js')), localStorage: storage || memoryStorage(), matchMedia: () => ({ matches: false }) },
    analyticsState: { cache: {} },
    safeRender: () => {}, renderWebsite: () => {}, renderSettings: () => {}, renderAnalytics: () => {}, renderSavedWebsites: () => {}, renderWebsiteBuilderBlock: () => {},
    loadWebsiteAnalytics: () => {}, qs: () => null,
  };
  vm.createContext(ctx); vm.runInContext(SOURCE, ctx, { filename: 'app.js (website functions)' });
  const app = ctx.__app;
  // what a fresh page load does when the Website view opens (renderWebsite -> both loaders), until everything settles
  async function coldLoad() {
    await Promise.all([app.loadCanonicalWebsite(true), app.loadSavedWebsites(true)]);
    for (let i = 0; i < 20 && (app.canonicalWebsite.inflight || app.multiProject.inflight || app.savedWebsites.inflight); i++) {
      await Promise.all([app.canonicalWebsite.inflight, app.multiProject.inflight, app.savedWebsites.inflight].filter(Boolean));
    }
    return app;
  }
  return { app, coldLoad, requests, storage: ctx.window.localStorage };
}

module.exports = { openTab, memoryStorage };
