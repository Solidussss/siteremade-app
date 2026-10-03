'use strict';
// Browser review of the Website editor -- NOT part of `npm test` (this repo has no browser dependency). The REAL builder
// (SITEREMADE_BUILDER_DIR: its server.js with its test mocks -- $0 provider spend -- and a purchased Creative website with
// its 3D model, from its test/helpers/three-d-scenario.js), this app's REAL website routes (test/helpers/app-harness.js),
// and the REAL frontend (index.html, app.js, website-creative-editor.js) served by the review mock backend for everything
// that is not a website route. Electron drives the editor at desktop and phone widths through real clicks
// (website-editor-capture.js): a free text edit, a scene colour, a paid AI rewrite confirmed against the builder's quote,
// the picture and 3D controls -- measuring sideways overflow and saving screenshots.
//
//   SITEREMADE_BUILDER_DIR=<builder> ELECTRON_PATH=<electron.exe> node test/review/website-editor-review.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { startApp } = require('../helpers/app-harness');
const mock = require('./mock-backend');

const BUILDER_DIR = process.env.SITEREMADE_BUILDER_DIR; const ELECTRON = process.env.ELECTRON_PATH;
const outDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'siteremade-editor-review'));
if (!BUILDER_DIR || !ELECTRON) { console.error('Set SITEREMADE_BUILDER_DIR and ELECTRON_PATH.'); process.exit(1); }
function png(w, h) {
  const T = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
  const crc = b => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 180 + (x % 60); raw[o + 1] = 30 + (y % 40); raw[o + 2] = 40; } }
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const { startServer, providerCalls } = require(path.join(BUILDER_DIR, 'test', 'helpers', 'server-process.js'));
  const S = require(path.join(BUILDER_DIR, 'test', 'helpers', 'three-d-scenario.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-editor-review-'));
  const env = S.threeDEnv(dir, { SITEREMADE_TRIAL_CREDITS: '200', MOCK_TRIPO: 'alternate', MOCK_CREATIVE_REVISE: 'words', HIGGSFIELD_VIDEO_ENDPOINT: 'kling-video/v3.0/4k/image-to-video', SITEREMADE_RATE_LIMIT_APP_BRIDGE_ACCOUNT_MAX: '100000' });
  const builder = await startServer(env); const sc = await S.buildThreeDScenario({ port: builder.port, env });
  // (one more owner picture -- wide and big enough for cinematic motion -- so every picture action shows)
  const bridge = async (m, u, b) => { const r = await fetch(`http://127.0.0.1:${builder.port}${u}`, { method: m, headers: { authorization: 'Bearer test-access-token-owner', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return r.json(); };
  const o = await bridge('GET', `/api/app-bridge/website/${sc.projectId}/creative`);
  const scene = o.outline.scenes.find(s => s.pictures.length);
  await bridge('POST', `/api/app-bridge/website/${sc.projectId}/creative/upload`, { baseRevision: o.revision, png: png(1600, 1000), title: 'Bottles on the bar', sceneId: o.outline.scenes[2].id, layerId: (o.outline.scenes[2].pictures[0] || scene.pictures[0]).layerId });
  const app = await startApp({ seed: { website_project_links: [{ id: 'l_review', workspace_id: 'ws_one', generator_project_id: sc.projectId, status: 'linked', linked_at: new Date().toISOString(), linked_by: 'u_owner' }], workspace_members: [], audit_logs: [] },
    builderUrl: `http://127.0.0.1:${builder.port}`, people: { owner: { userId: 'u_owner', access: 'test-access-token-owner', workspaces: [{ id: 'ws_one', business_name: 'Aurelia Tonic' }] } } });
  const front = await mock.start(0); const frontPort = front.address().port; const appUrl = new URL(app.base);
  // the review's own front door: website routes -> the app's real routes (as the owner); everything else -> the mock backend
  const door = http.createServer((req, res) => {
    const website = /^\/api\/app\/(website|websites)(\/|$|\?)/.test(req.url);
    const target = website ? { host: appUrl.hostname, port: appUrl.port } : { host: '127.0.0.1', port: frontPort };
    const headers = Object.assign({}, req.headers, website ? { 'x-test-as': 'owner' } : {}); delete headers.host;
    const p = http.request({ host: target.host, port: target.port, path: req.url, method: req.method, headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(p);
  });
  await new Promise(r => door.listen(0, '127.0.0.1', r));
  const job = path.join(outDir, 'editor.job.json');
  fs.writeFileSync(job, JSON.stringify({ baseUrl: `http://127.0.0.1:${door.address().port}/`, outDir, widths: [1440, 390] }));
  const before = providerCalls(env.MOCK_CALL_LOG).length;
  const eenv = Object.assign({}, process.env); delete eenv.ELECTRON_RUN_AS_NODE;
  await new Promise(resolve => { const child = spawn(ELECTRON, [path.join(__dirname, 'website-editor-capture.js'), job], { stdio: 'inherit', env: eenv }); const t = setTimeout(() => child.kill(), 600000); child.on('exit', () => { clearTimeout(t); resolve(); }); });
  const calls = providerCalls(env.MOCK_CALL_LOG).slice(before);
  const res = JSON.parse(fs.readFileSync(path.join(outDir, 'editor-result.json'), 'utf8'));
  res.providerCallsDuringReview = calls.map(c => `${c.provider}${c.tool ? ':' + c.tool : ''}${c.endpoint ? ':' + c.endpoint : ''}`);
  res.realProviders = 'none: the builder ran with its test mocks (run-server.js refuses every real paid provider)';
  fs.writeFileSync(path.join(outDir, 'editor-result.json'), JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res, null, 1));
  door.close(); front.close(); await app.stop(); await builder.stop();
})().catch(e => { console.error(e); process.exit(1); });
