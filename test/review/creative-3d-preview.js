'use strict';
// A CREATIVE PAGE'S 3D MODEL IN THE APP'S PREVIEW, in a real browser -- NOT part of `npm test` (it needs Electron and a
// GPU, and the builder checkout):
//
//   SITEREMADE_BUILDER_DIR=<builder checkout> ELECTRON_PATH=<electron.exe> node test/review/creative-3d-preview.js <outDir>
//   (inside VS Code's terminal, clear ELECTRON_RUN_AS_NODE first -- with it set, Electron runs as plain Node)
//
// Both real servers: the builder (its test helper makes a purchased Creative page whose 3D model was made by its job --
// Tripo answered by a fake -- and saved BY REFERENCE) and this app's real routes (test/helpers/app-harness.js). Then a
// browser opens the app's preview the two ways a customer does -- the Website view's sandboxed frame, and the
// "Preview" link on its own -- and the report says, for each: did the 3D engine load and run, was the GLB read, was the
// model drawn and turned by scrolling, did the security policy refuse anything. $0 provider spend.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { startApp } = require('../helpers/app-harness');

const BUILDER_DIR = process.env.SITEREMADE_BUILDER_DIR; const ELECTRON = process.env.ELECTRON_PATH;
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'sr-app-3d-preview'));
if (!BUILDER_DIR || !ELECTRON) { console.error('set SITEREMADE_BUILDER_DIR and ELECTRON_PATH'); process.exit(2); }

(async () => {
  const { startServer } = require(path.join(BUILDER_DIR, 'test', 'helpers', 'server-process.js'));
  const S = require(path.join(BUILDER_DIR, 'test', 'helpers', 'three-d-scenario.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-app-3d-review-')); const env = S.threeDEnv(dir);
  const builder = await startServer(env); let app = null; let code = 1;
  try {
    const s = await S.buildThreeDScenario({ port: builder.port, env });
    app = await startApp({ seed: { website_project_links: [], workspace_members: [] }, builderUrl: `http://127.0.0.1:${builder.port}`,
      people: { owner: { userId: 'u_owner', access: 'test-access-token-owner', workspaces: [{ id: 'ws_aurelia', business_name: 'Aurelia Tonic' }] } } });
    await app.call('owner', 'GET', '/api/app/websites'); // (connects the sole business's website)
    fs.mkdirSync(OUT, { recursive: true });
    const job = path.join(OUT, 'job.json');
    fs.writeFileSync(job, JSON.stringify({ base: app.base, as: 'owner', outDir: OUT, assetRef: s.assetRef,
      views: [{ name: 'website-view-frame', url: `/api/app/website/projects/${s.projectId}/preview`, frame: true }, { name: 'preview-link', url: `/api/app/websites/${s.projectId}/preview?source=published`, frame: false }] }));
    const childEnv = Object.assign({}, process.env); delete childEnv.ELECTRON_RUN_AS_NODE;
    code = await new Promise(resolve => { const c = spawn(ELECTRON, [path.join(__dirname, 'creative-3d-preview-worker.js'), job], { env: childEnv, stdio: 'inherit' }); c.on('exit', resolve); });
    const report = JSON.parse(fs.readFileSync(path.join(OUT, 'report.json'), 'utf8'));
    const calls = fs.readFileSync(env.MOCK_CALL_LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    report.tripoSubmits = calls.filter(c => c.provider === 'tripo' && c.endpoint === 'submit').length;
    report.otherPaidCalls = calls.filter(c => ['anthropic', 'openai', 'higgsfield', 'serpapi'].includes(c.provider)).length;
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
    console.log(JSON.stringify(report, null, 1));
    code = report.views.every(v => v.ok) ? 0 : 1;
  } finally { if (app) await app.stop(); await builder.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  process.exit(code);
})().catch(e => { console.error(e); process.exit(1); });
