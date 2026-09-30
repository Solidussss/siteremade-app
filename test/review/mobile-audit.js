'use strict';
// Mobile audit of the Client App -- NOT part of `npm test` (this repo has no browser dependency). Starts the mock
// backend (test/review/mock-backend.js: the real frontend files, realistic awkward data, no Supabase/builder/Stripe)
// and renders every customer screen in Electron at phone, tablet and desktop sizes (test/review/mobile-capture.js),
// measuring sideways overflow, cut-off controls, tap sizes, iOS-zoom inputs, tiny text, fixed bars and dialogs.
//
//   ELECTRON_PATH=<electron.exe> [MOBILE_SITE_DIR=<a compiled website folder for the preview>] node test/review/mobile-audit.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { start } = require('./mock-backend');

const outDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'siteremade-app-mobile'));
const ELECTRON = process.env.ELECTRON_PATH;
if (!ELECTRON || !fs.existsSync(ELECTRON)) { console.error('Set ELECTRON_PATH to an Electron binary.'); process.exit(1); }
const WIDTHS = (process.env.MOBILE_WIDTHS || '320,360,375,390,412,430,768,820,1440').split(',').map(Number);
const LANDSCAPE = process.env.MOBILE_LANDSCAPE === '0' ? [] : [[667, 375], [844, 390]];

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const server = await start(0);
  const jobFile = path.join(outDir, 'mobile.job.json');
  fs.writeFileSync(jobFile, JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}/`, outDir, widths: WIDTHS, landscape: LANDSCAPE }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; // set inside VS Code terminals; it makes Electron behave as plain Node
  // asynchronous on purpose: the mock backend runs in THIS process and must keep answering while Electron renders
  await new Promise(resolve => { const child = spawn(ELECTRON, [path.join(__dirname, 'mobile-capture.js'), jobFile], { stdio: 'inherit', env }); const t = setTimeout(() => child.kill(), 1500000); child.on('exit', () => { clearTimeout(t); resolve(); }); });
  server.close();
  const res = JSON.parse(fs.readFileSync(path.join(outDir, 'mobile-result.json'), 'utf8'));
  const lines = [];
  if (res.error) lines.push('ERROR ' + res.error);
  for (const [name, sizes] of Object.entries(res.scenarios || {})) {
    lines.push(`\n== ${name}`);
    for (const [size, m] of Object.entries(sizes)) {
      if (m.error) { lines.push(`  ${size} ERROR ${m.error}`); continue; }
      const c = m.check || {};
      const flags = [m.overflowX ? `SIDEWAYS(${m.scrollWidth}>${m.clientWidth})` : '', m.wide.length ? `wide:${m.wide.length}` : '', m.clipped.length ? `clipped:${m.clipped.length}` : '', m.zoom.length ? `iosZoom:${m.zoom.length}` : '', m.tapCount ? `smallTaps:${m.tapCount}` : '', m.tiny ? `tinyText:${m.tiny}` : '',
        c.lastHidden ? 'NAV-COVERS-END' : '', c.fits === false ? 'DIALOG-OVERFLOWS' : '', c.scrolls === false ? 'DIALOG-NO-SCROLL' : ''].filter(Boolean).join(' ');
      lines.push(`  ${size.padEnd(9)} ${flags || 'ok'}`);
    }
  }
  if (res.checks) lines.push('\nchecks: ' + JSON.stringify(res.checks));
  fs.writeFileSync(path.join(outDir, 'mobile-summary.txt'), lines.join('\n'));
  console.log(lines.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
