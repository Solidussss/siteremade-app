'use strict';
// THE APP'S PREVIEW IN SAFARI'S ENGINE, INSIDE THE APP'S SANDBOXED FRAME -- NOT part of `npm test` (it needs Playwright's
// WebKit and the builder checkout). Production bug, 2026-10-04: Safari read the preview's policy differently from Chromium
// inside the sandboxed frame and refused the 3D model -- every Chromium check passed. This runs the real builder (its 3D
// scenario: a purchased Creative page, the model made by a fake Tripo) and this app's real routes, uploads an owner's .glb
// into a scene (free), and opens the preview exactly as the Website view frames it, in WebKit as an iPhone 13. It fails
// on: a refused resource, a script error, the page closing, or the 3D model not drawing and turning on its own. $0.
//
//   SITEREMADE_BUILDER_DIR=<builder> PLAYWRIGHT_DIR=<folder with playwright> node test/review/preview-safari.js <outDir> [model.glb]
// (the preview reports its own 3D state to the wrapper -- a test-only reporter added to the response -- since a sandboxed
// frame cannot be scripted from outside)
const fs = require('fs'); const os = require('os'); const path = require('path');
const { webkit, devices } = process.env.PLAYWRIGHT_DIR ? require(path.join(process.env.PLAYWRIGHT_DIR, 'node_modules', 'playwright')) : require('playwright');
const APP = path.join(__dirname, '..', '..'); const BUILDER_DIR = process.env.SITEREMADE_BUILDER_DIR; if (!BUILDER_DIR) { console.error('set SITEREMADE_BUILDER_DIR'); process.exit(2); }
const { startApp } = require(APP + '/test/helpers/app-harness');
const OUT = process.argv[2]; fs.mkdirSync(OUT, { recursive: true });
const REPORTER = `<script>(function(){function st(){var s=window.__sr3d||{};var g=(s.stages||[]).filter(function(x){return x.id===window.__T})[0]||{};return{state:s.state,why:s.why,engine:s.engine,stage:g.state,stageWhy:g.why,frames:g.frames||0,rotY:g.pose?Math.round(g.pose.rotY*573)/10:null,ids:(s.stages||[]).map(function(x){return x.id+':'+x.state+':'+(x.why||'')}).join(',')}}
window.addEventListener('message',function(e){var m=e.data||{};if(m.cmd==='target'){window.__T=m.id}if(m.cmd==='scroll'){var el=document.querySelector('.td-stage[data-td="'+window.__T+'"]');var y=el?el.closest('.sc').getBoundingClientRect().top+scrollY:0;scrollTo(0,y+(m.dy||0))}if(m.cmd==='state'){parent.postMessage({rep:st()},'*')}});})();</script>`;
(async () => {
  const { startServer } = require(path.join(BUILDER_DIR, 'test', 'helpers', 'server-process.js'));
  const S = require(path.join(BUILDER_DIR, 'test', 'helpers', 'three-d-scenario.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-wk3dframe-')); const env = S.threeDEnv(dir);
  const builder = await startServer(env); let app = null; let crashed = false; let code = 1;
  try {
    const s = await S.buildThreeDScenario({ port: builder.port, env });
    app = await startApp({ seed: { website_project_links: [], workspace_members: [] }, builderUrl: `http://127.0.0.1:${builder.port}`,
      people: { owner: { userId: 'u_owner', access: 'test-access-token-owner', workspaces: [{ id: 'ws_aurelia', business_name: 'Aurelia Tonic' }] } } });
    await app.call('owner', 'GET', '/api/app/websites');
    const ol = await app.call('owner', 'GET', `/api/app/website/projects/${s.projectId}/creative`); const outl = ol.body.outline;
    const target = outl.scenes.find(x => !x.models.length && x.pictures.some(p => p.layerId)) || outl.scenes.find(x => !x.models.length);
    const glb = fs.readFileSync(process.argv[3] || path.join(BUILDER_DIR, 'test', 'fixtures', 'three-d', 'product-normalized.glb'));
    const up = await app.call('owner', 'POST', `/api/app/website/projects/${s.projectId}/creative/model-upload`, { baseRevision: ol.body.revision, glb: 'data:model/gltf-binary;base64,' + glb.toString('base64'), sceneId: target.id, title: 'orb' });
    console.log('upload', up.status, 'scene', target.id);
    const b = await webkit.launch(); const ctx = await b.newContext({ ...devices['iPhone 13'], extraHTTPHeaders: { 'x-test-as': 'owner' } }); const pg = await ctx.newPage();
    const msgs = []; pg.on('console', m => msgs.push(m.type() + ': ' + m.text().slice(0, 220))); pg.on('crash', () => { crashed = true; console.log('PAGE CRASHED; console so far:', JSON.stringify(msgs.slice(-12), null, 1)); }); pg.on('close', () => console.log('PAGE CLOSED'));
    const SANDBOX = process.env.NOSANDBOX ? '' : 'sandbox="allow-scripts allow-forms allow-popups"';
    const pvUrl = `${app.base}/api/app/websites/${s.projectId}/preview`;
    await pg.route(pvUrl, async r => { const res = await r.fetch(); const body = (await res.text()).replace('</body>', REPORTER + '</body>'); await r.fulfill({ response: res, body }); });
    await pg.route(app.base + '/wrapper.html', r => r.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><meta name=viewport content="width=device-width"><body style=margin:0><iframe id=f ${SANDBOX} src="${pvUrl}" style="width:390px;height:844px;border:0"></iframe><script>window.rep=null;addEventListener('message',e=>{if(e.data&&e.data.rep)window.rep=e.data.rep})</script>` }));
    await pg.goto(app.base + '/wrapper.html'); await pg.waitForTimeout(3000);
    const send = m => pg.evaluate(m => document.getElementById('f').contentWindow.postMessage(m, '*'), m);
    const st = async () => { await pg.evaluate(() => { window.rep = null; }); await send({ cmd: 'state' }); await pg.waitForTimeout(300); return pg.evaluate(() => window.rep); };
    await send({ cmd: 'target', id: 'td-' + target.id });
    console.log('at load', JSON.stringify(await st()));
    await send({ cmd: 'scroll', dy: -100 }); await pg.waitForTimeout(4000);
    console.log('near', JSON.stringify(await st()));
    await pg.waitForTimeout(2000); console.log('2s later', JSON.stringify(await st()));
    await pg.screenshot({ path: path.join(OUT, 'frame.png') });
    const bad = msgs.filter(m => /^error|refused|security policy/i.test(m)); const a = await st(); const b2 = await (async () => { await pg.waitForTimeout(1500); return st(); })();
    const ok = !crashed && !bad.length && a && a.stage === 'on' && b2 && b2.rotY !== a.rotY;
    console.log(JSON.stringify({ ok, crashed, refused: bad.slice(0, 6), stage: a && a.stage, why: a && a.stageWhy, turnsOnItsOwn: !!(a && b2 && b2.rotY !== a.rotY) }, null, 1)); code = ok ? 0 : 1;
    await b.close();
  } finally { if (app) await app.stop(); await builder.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  process.exit(code);
})().catch(e => { console.error(e); process.exit(1); });
