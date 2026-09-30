'use strict';
// Electron worker for test/review/mobile-audit.js -- NOT part of `npm test`. Renders the REAL Client App (index.html +
// app.js + stylesheets) against the mock backend at phone, tablet and desktop sizes -- emulated as real devices
// (mobile viewport, touch, overlay scrollbars) -- and measures each screen (test/review/mobile-metrics.js).
// job: { baseUrl, outDir, widths, landscape }
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const metrics = require('./mobile-metrics');

const job = JSON.parse(fs.readFileSync(process.argv[process.argv.length - 1], 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.disableHardwareAcceleration();
const SIZES = job.widths.map(w => [w, w >= 768 ? 1024 : 800]).concat(job.landscape || []);
const out = { scenarios: {}, checks: {} };
const js = (w, code) => w.webContents.executeJavaScript(code);
const dbg = (w, m, p) => w.webContents.debugger.sendCommand(m, p || {});
async function setSize(w, [width, height]) {
  const mobile = width < 1024;
  await dbg(w, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  await dbg(w, 'Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
}
async function shoot(w, name, [width, height]) {
  const { data } = await dbg(w, 'Page.captureScreenshot', { format: 'png' });
  const file = `${name}-${width}x${height}.png`;
  fs.writeFileSync(path.join(job.outDir, file), Buffer.from(data, 'base64'));
  return file;
}
async function screens(w, name, size, maxScreens, anchor) {
  const files = [];
  await js(w, 'document.documentElement.style.scrollBehavior = "auto"; true');
  const start = anchor ? await js(w, `(() => { const e = document.querySelector(${JSON.stringify(anchor)}); return e ? Math.max(0, e.getBoundingClientRect().top + scrollY - 8) : 0; })()`) : 0;
  const total = await js(w, 'document.documentElement.scrollHeight');
  for (let i = 0; i < maxScreens && start + i * size[1] < total; i++) {
    await js(w, `window.scrollTo({ top: ${start + i * size[1]}, behavior: "instant" }); true`); await sleep(300);
    files.push(await shoot(w, `${name}-p${i}`, size));
  }
  await js(w, 'window.scrollTo({ top: 0, behavior: "instant" }); true');
  return files;
}
async function measureAll(w, name, { scope, prepare, maxScreens = 1, anchor, check } = {}) {
  const res = {};
  for (const size of SIZES) {
    console.log('[mobile]', name, size.join('x'));
    await setSize(w, size); await sleep(600);
    let prepError = null;
    if (prepare) await js(w, `{ ${prepare} }`).catch(e => { prepError = String(e).slice(0, 200); });
    await sleep(500);
    const m = await js(w, metrics(scope)).catch(e => ({ error: String(e).slice(0, 200) }));
    if (prepError) m.prepError = prepError;
    if (check) m.check = await js(w, check).catch(e => ({ error: String(e).slice(0, 200) }));
    m.shots = await screens(w, name, size, maxScreens, anchor);
    res[`${size[0]}x${size[1]}`] = m;
  }
  out.scenarios[name] = res;
  fs.writeFileSync(path.join(job.outDir, 'mobile-result.json'), JSON.stringify(out, null, 1));
}
const scenario = (w, q) => js(w, `fetch('/__scenario?${q}').then(() => true)`);
async function load(w) { console.log('[mobile] load'); await w.loadURL(job.baseUrl); await sleep(2500); console.log('[mobile] loaded'); }
const view = v => `switchView(${JSON.stringify(v)}); window.scrollTo({ top: 0, behavior: "instant" }); true`;
// the fixed bottom navigation must never sit on top of the last thing on the page
const BOTTOM_NAV_CHECK = `(() => { const nav = document.querySelector('.mobile-nav'); if (!nav || getComputedStyle(nav).display === 'none') return { nav: false };
  const r = nav.getBoundingClientRect(); window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
  const main = document.querySelector('.view.active'); const kids = main ? [...main.querySelectorAll('button, a, p, li, input, textarea')].filter(e => e.getBoundingClientRect().height > 0) : [];
  const last = kids[kids.length - 1]; const lr = last ? last.getBoundingClientRect() : null; window.scrollTo({ top: 0, behavior: "instant" });
  return { nav: true, navTop: Math.round(r.top), navHeight: Math.round(r.height), lastBottomAtEnd: lr ? Math.round(lr.bottom) : null, lastHidden: lr ? lr.bottom > r.top + 1 : false, safeArea: getComputedStyle(nav).paddingBottom }; })()`;
const DIALOG_CHECK = sel => `(() => { const d = document.querySelector(${JSON.stringify(sel)}); if (!d) return null; const r = d.getBoundingClientRect(); const s = getComputedStyle(d);
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), fits: r.top >= -1 && r.bottom <= innerHeight + 1, scrolls: d.scrollHeight > d.clientHeight + 1 ? /auto|scroll/.test(s.overflowY) : true, left: Math.round(r.left), right: Math.round(r.right) }; })()`;

app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1440, height: 1024, show: true, webPreferences: { backgroundThrottling: false } });
  w.webContents.debugger.attach('1.3');
  try {
    await w.loadURL(job.baseUrl); await sleep(500);
    // signed out: sign in, create account, forgot password
    await scenario(w, 'auth=0'); await load(w);
    await measureAll(w, 'login', { scope: '#authScreen' });
    await measureAll(w, 'signup', { scope: '#authScreen', prepare: `(() => { const t = document.querySelector('[data-auth-tab="signup"], #showSignup, [data-tab="signup"]'); if (t) t.click(); return true; })()` });
    // signed in, several websites, one with unpublished changes
    await scenario(w, 'auth=1&saved=many&locked=0&unpublished=1'); await load(w);
    await measureAll(w, 'website', { prepare: view('website'), maxScreens: 12, check: BOTTOM_NAV_CHECK });
    await measureAll(w, 'saved-websites-many', { scope: '#savedWebsites', prepare: view('website') + ';loadSavedWebsites(true).then(() => true)', anchor: '#savedWebsites', maxScreens: 4 });
    await measureAll(w, 'editor-planning', { scope: '#siteEditor', prepare: `${view('website')}; const i = document.getElementById('siteEditorInput'); i.value = 'Make this website feel way more premium and less generic.'; setEditorState('planning', { redesign: true, error: null, edit: null }); document.getElementById('siteEditor').scrollIntoView(); true`, anchor: '#siteEditor' });
    await measureAll(w, 'editor-review', { scope: '#siteEditor', prepare: `${view('website')}; setEditorState('preview_ready', { redesign: true, edit: { revision: 10, mode: 'deep', changeSummary: ['Redesigned the top of your homepage, with a new headline', 'Switched to a serif editorial type pairing', 'Changed the site to a more editorial layout and rhythm', 'Reworked the structure of the homepage and 3 other pages', 'Rewrote copy on 4 pages', 'Changed the colour treatment to a dark, luxurious treatment'], creditsCharged: 1, creditsRemaining: 86 } }); document.getElementById('siteEditor').scrollIntoView(); true`, anchor: '#siteEditor' });
    await measureAll(w, 'editor-failed', { scope: '#siteEditor', prepare: `${view('website')}; setEditorState('failed', { error: { message: 'The redesign did not produce a meaningful enough change, so nothing was saved and no credits were used. Try describing what you want to see, or send it to the SiteRemade team.' } }); document.getElementById('siteEditor').scrollIntoView(); true`, anchor: '#siteEditor' });
    await js(w, `setEditorState('idle', { error: null, edit: null }); true`);
    await measureAll(w, 'analytics', { prepare: view('analytics') + '; loadWebsiteAnalytics(true); true', maxScreens: 6, check: BOTTOM_NAV_CHECK });
    await measureAll(w, 'ads', { prepare: view('ads'), maxScreens: 4, check: BOTTOM_NAV_CHECK });
    await measureAll(w, 'contact', { prepare: view('contact') + `; const b = document.querySelector('#contactList button, #contactList [data-ct-open]'); if (b) b.click(); true`, maxScreens: 4, check: BOTTOM_NAV_CHECK });
    await measureAll(w, 'settings', { prepare: view('settings'), maxScreens: 8, check: BOTTOM_NAV_CHECK });
    await measureAll(w, 'notifications', { prepare: view('website') + `; const b = document.getElementById('notificationButton') || document.querySelector('[aria-label*="otification"]'); if (b) b.click(); else document.getElementById('notificationPopover').hidden = false; true`, scope: '#notificationPopover', check: DIALOG_CHECK('#notificationPopover') });
    await js(w, `document.getElementById('notificationPopover').hidden = true; true`);
    await measureAll(w, 'modal', { prepare: `document.getElementById('leadModal').hidden = false; true`, scope: '#leadModal', check: DIALOG_CHECK('#leadModal .lead-modal') });
    await js(w, `document.getElementById('leadModal').hidden = true; true`);
    // one website only, and none at all
    await scenario(w, 'saved=one&unpublished=0'); await load(w);
    await measureAll(w, 'saved-websites-one', { scope: '#savedWebsites', prepare: view('website'), anchor: '#savedWebsites' });
    await scenario(w, 'saved=none'); await load(w);
    await measureAll(w, 'saved-websites-none', { scope: '#savedWebsites', prepare: view('website'), anchor: '#savedWebsites' });
    // the Workspace plan lapsed: the website area stays, paid views are limited
    await scenario(w, 'saved=many&locked=1'); await load(w);
    await measureAll(w, 'locked', { prepare: view('website'), maxScreens: 3 });
    await scenario(w, 'locked=0'); await load(w);
    // mobile navigation actually switches views on a phone
    await setSize(w, [390, 800]); await sleep(600);
    out.checks.mobileNav = await js(w, `(async () => { const res = {}; for (const v of ['analytics', 'ads', 'contact', 'settings', 'website']) { const b = document.querySelector('.mobile-nav button[data-view="' + v + '"]'); if (!b) { res[v] = 'no button'; continue; } const r = b.getBoundingClientRect(); b.click(); await new Promise(r => setTimeout(r, 300)); res[v] = { active: !!document.querySelector('#view-' + v + '.active'), tap: [Math.round(r.width), Math.round(r.height)] }; } return res; })()`);
  } catch (e) { out.error = String(e && e.stack || e).slice(0, 2000); }
  fs.writeFileSync(path.join(job.outDir, 'mobile-result.json'), JSON.stringify(out, null, 1));
  app.quit();
});
