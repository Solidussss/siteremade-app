'use strict';
// "Update My Website": after an update the app previews the saved DRAFT (the builder's
// GET /api/app-bridge/website/:id/preview?source=draft), and the published website otherwise -- the bridge client asks
// for exactly one of them, with the customer's own token. Real HTTP to a stub builder.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bridge = require('../lib/generator-bridge');

const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

test('the preview asks the builder for the draft only when told to, with the customer\'s token', async () => {
  const seen = [];
  const builder = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(req.url.endsWith('?source=draft') ? '<html>draft</html>' : '<html>published</html>');
  });
  const port = await listen(builder);
  process.env.WEBSITE_BUILDER_URL = `http://127.0.0.1:${port}`;
  try {
    const published = await bridge.getPreview('user-access-token', 'proj_ABCDEFGHIJKLMNOPQRSTUV12');
    const draft = await bridge.getPreview('user-access-token', 'proj_ABCDEFGHIJKLMNOPQRSTUV12', { draft: true });
    assert.equal(published.status, 200); assert.equal(published.text, '<html>published</html>');
    assert.equal(draft.status, 200); assert.equal(draft.text, '<html>draft</html>');
    assert.deepEqual(seen.map(s => s.url), ['/api/app-bridge/website/proj_ABCDEFGHIJKLMNOPQRSTUV12/preview', '/api/app-bridge/website/proj_ABCDEFGHIJKLMNOPQRSTUV12/preview?source=draft']);
    assert.ok(seen.every(s => s.auth === 'Bearer user-access-token'));
  } finally { await new Promise(r => builder.close(r)); }
});

test('an update request waits long enough for a whole-site redesign', async () => {
  // the edit call must not give up before the builder's redesign planner (100s) and a Creative revision can finish
  const src = require('fs').readFileSync(require.resolve('../lib/generator-bridge'), 'utf8');
  const edit = Number((/\bedit:\s*(\d+)/.exec(src) || [])[1]);
  assert.ok(edit >= 200000, `edit timeout ${edit}ms`);
});
