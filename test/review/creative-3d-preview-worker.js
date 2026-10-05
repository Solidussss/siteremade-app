'use strict';
// Electron worker for test/review/creative-3d-preview.js -- NOT part of `npm test`.
// job: { base, as, outDir, assetRef, views: [{ name, url, frame }] }
// Each view opens in a fresh window. Sign-in is the test harness's header (x-test-as). In the preview's own document a
// small recorder notes each script the page adds and each fetch() it makes -- what the 3D loader and the engine do -- and
// every security-policy refusal. Then the page is scrolled to its 3D scene and through it.
const { app, BrowserWindow, session } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const job = JSON.parse(fs.readFileSync(process.argv[process.argv.length - 1], 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const step = m => fs.appendFileSync(path.join(job.outDir, 'steps.log'), new Date().toISOString().slice(11, 23) + ' ' + m + '\n');
const within = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error('timed out: ' + what); })]);
app.on('window-all-closed', () => {});
// (installed in the preview's own document once it has loaded -- before its 3D scene is near, so before the loader asks
// for anything: the page fetches its engine and model only when the scene comes close)
const RECORDER = `(() => { if (window.__rec) return; const rec = window.__rec = { scripts: [], fetches: [], violations: [] };
  const short = u => { u = String(u); return u.startsWith('data:') ? u.slice(0, u.indexOf(',') + 1) + '…(' + u.length + ' chars)' : u.slice(0, 120); };
  const ap = Node.prototype.appendChild; Node.prototype.appendChild = function (n) { if (n && n.tagName === 'SCRIPT' && n.src) { const e = { src: short(n.src), loaded: null }; rec.scripts.push(e); n.addEventListener('load', () => { e.loaded = true; }); n.addEventListener('error', () => { e.loaded = false; }); } return ap.call(this, n); };
  const f = window.fetch; window.fetch = function (u, o) { const url = String((u && u.url) || u); const e = { url: short(url), ok: null, bytes: 0, sha256: '' }; rec.fetches.push(e);
    return f.call(this, u, o).then(r => { e.ok = r.ok; if (url.startsWith('data:') || url.includes('/preview-file/')) r.clone().arrayBuffer().then(b => { e.bytes = b.byteLength; return crypto.subtle.digest('SHA-256', b); }).then(h => { e.sha256 = [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join(''); }).catch(() => {}); return r; }, err => { e.ok = false; e.error = String(err && err.message || err).slice(0, 80); throw err; }); };
  document.addEventListener('securitypolicyviolation', e => rec.violations.push(e.violatedDirective + ' ' + String(e.blockedURI).slice(0, 40)));
})();`;

app.whenReady().then(async () => {
  const report = { base: job.base, views: [] };
  for (const v of job.views) {
    const ses = session.fromPartition('sr3d-' + v.name + '-' + process.pid);
    ses.webRequest.onBeforeSendHeaders({ urls: [job.base + '/*'] }, (d, cb) => { d.requestHeaders['x-test-as'] = job.as; cb({ requestHeaders: d.requestHeaders }); });
    // (only this machine: anything else the app shell or the page asks for is refused, and listed)
    const net = []; const outside = []; ses.webRequest.onBeforeRequest((d, cb) => { const local = d.url.startsWith(job.base) || /^(data|blob|devtools|about|chrome-extension):/.test(d.url); if (!local) outside.push(d.url.slice(0, 100)); else net.push(d.url.replace(job.base, '').slice(0, 120)); cb({ cancel: !local }); });
    step(v.name + ': window');
    const w = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false, session: ses } });
    // the page itself, or the app's own page holding it in the Website view's frame (same sandbox, same origin)
    if (v.frame) {
      await within(w.loadURL(job.base + '/'), 30000, 'the app page'); step(v.name + ': app page');
      await w.webContents.executeJavaScript(`document.open(); document.write('<!doctype html><body style="margin:0"><iframe id="websiteFrame" title="Your website" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" src="${v.url}" style="width:1400px;height:880px;border:0"></iframe></body>'); document.close(); true`);
    } else await within(w.loadURL(job.base + v.url), 60000, 'the preview');
    step(v.name + ': loaded');
    // (code runs in the preview's own document: the frame's, when it is framed)
    const target = () => (v.frame ? w.webContents.mainFrame.frames[0] : w.webContents.mainFrame);
    const inPage = code => target().executeJavaScript(code);
    let ready = false; for (let i = 0; i < 100 && !ready; i++) { ready = await inPage(`!!(window.__sr3d && document.querySelector('.td-stage'))`).catch(() => false); if (!ready) await sleep(150); }
    const top = await inPage(`(() => { const el = document.querySelector('.td-stage'); return el ? Math.round(el.closest('.sc').getBoundingClientRect().top + window.scrollY) : -1; })()`).catch(() => -1);
    const state = () => inPage(`(() => { const s = window.__sr3d || {}; const g = (s.stages || [])[0] || {}; return { state: s.state, why: s.why, engine: s.engine, stage: g.state, stageWhy: g.why, frames: g.frames || 0, rotYdeg: g.pose ? Math.round(g.pose.rotY * 1800 / Math.PI) / 10 : null, engineRan: !!window.SiteRemade3D }; })()`);
    const atLoad = await state(); // (before scrolling: nothing 3D should have been asked for yet -- it loads near the scene)
    // the recorder goes in now -- the page is loaded, its 3D still waiting (the loader asks for nothing until the scene is near)
    await inPage(RECORDER); step(v.name + ': recorder in ' + (v.frame ? 'the frame' : 'the page') + ', 3D engine so far: ' + atLoad.engine);
    const scriptsAtLoad = (await inPage('window.__rec.scripts.length')); const fetchesAtLoad = (await inPage('window.__rec.fetches.length'));
    await inPage(`window.scrollTo(0, ${top - 200})`);
    let st = null; for (let i = 0; i < 120; i++) { st = await state(); if (st.stage === 'on' || st.stage === 'poster') break; await sleep(150); }
    await sleep(900); const before = await state();
    await inPage(`window.scrollTo(0, ${top + 400})`); await sleep(900); const after = await state();
    await sleep(300); const rec = await inPage('window.__rec');
    const img = await Promise.race([w.webContents.capturePage(), sleep(8000).then(() => null)]); if (img) fs.writeFileSync(path.join(job.outDir, v.name + '.png'), img.toPNG());
    // (inlined as data: URLs, or -- lifted out of the page by lib/preview-files.js -- from this app's preview-file path)
    const lifted = u => /^data:/.test(u) || /\/api\/app\/website\/preview-file\/[a-f0-9]{40}$/.test(u);
    const engineScript = rec.scripts.find(x => lifted(x.src)); const glb = rec.fetches.find(x => lifted(x.url) && x.sha256 === job.assetRef);
    const out = {
      name: v.name, url: v.url, inAppFrame: v.frame, csp: null,
      atLoad: { scriptsAdded: scriptsAtLoad, fetches: fetchesAtLoad, engine: atLoad.engine },
      runtimeRequest: engineScript || null, glbRequest: glb ? { url: glb.url, ok: glb.ok, bytes: glb.bytes, sameModelAsStored: true } : null,
      otherFetches: rec.fetches.filter(x => x !== glb).map(x => ({ url: x.url, ok: x.ok })).slice(0, 6),
      drawn: before, afterScroll: after, turnedDeg: before.rotYdeg != null && after.rotYdeg != null ? +(after.rotYdeg - before.rotYdeg).toFixed(1) : null,
      violations: [...new Set(rec.violations)], refusedOutside: [...new Set(outside)].slice(0, 6), networkRequests: [...new Set(net)].filter(u => !u.startsWith('data:') && !u.startsWith('devtools')).slice(0, 10),
    };
    out.ok = !!(engineScript && engineScript.loaded && before.engineRan && glb && glb.ok && before.stage === 'on' && before.frames > 0 && out.turnedDeg && Math.abs(out.turnedDeg) > 20 && !out.violations.length);
    report.views.push(out); w.destroy();
  }
  fs.writeFileSync(path.join(job.outDir, 'report.json'), JSON.stringify(report, null, 1)); app.exit(0);
}).catch(e => { fs.writeFileSync(path.join(job.outDir, 'worker-error.txt'), String(e && e.stack || e)); app.exit(1); });
