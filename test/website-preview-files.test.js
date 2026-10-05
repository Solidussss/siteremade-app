'use strict';
// THE WEBSITE PREVIEW'S FILES (lib/preview-files.js). The builder sends a preview as one page with every file inlined;
// a Creative page with its pictures, clips, 3D engine and 3D model made that page tens of megabytes, parsed again on
// every change, and an iPhone closed the tab. The big files are lifted out of the page and served from one path of this
// app -- by an id that is the only key to them, a clip in ranges as Safari asks for it.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startApp } = require('./helpers/app-harness');
const { startFixtureBuilder } = require('./helpers/fixture-builder');
// (the harness loads the app's modules afresh: the one its routes use is read after it starts)
const files = () => require(path.join(__dirname, '..', 'lib', 'preview-files.js'));

const big = (head, n) => Buffer.concat([Buffer.from(head, 'latin1'), Buffer.alloc(n, 7)]);
const uri = (type, buf) => `data:${type};base64,${buf.toString('base64')}`;
const PNG = big('\x89PNG\r\n\x1a\n', 120000);
const GLB = big('glTF\x02\x00\x00\x00', 90000);
const MP4 = big('\x00\x00\x00\x18ftypmp42', 200000);
const ENGINE = Buffer.from('/*! engine */\nvar SiteRemade3D=(()=>{' + 'x;'.repeat(40000) + '})();');
const TINY = big('\x89PNG\r\n\x1a\n', 500);
const HTML = big('<script>alert(1)</script>', 60000);

test('a preview page keeps its small files inline and lifts the big ones -- the builder\'s octet-stream files by what they are', () => {
  const page = `<!doctype html><img src="${uri('image/png', PNG)}"><img src="${uri('image/png', TINY)}"><video src="${uri('video/mp4', MP4)}"></video>` +
    `<script type="application/json" id="cr-3d">{"runtime":"${uri('application/octet-stream', ENGINE)}","scenes":[{"model":"${uri('application/octet-stream', GLB)}"}]}</script>` +
    `<iframe src="${uri('text/html', HTML)}"></iframe><div style="background:url(${uri('image/png', PNG)})"></div>`;
  const FILES = files(); const out = FILES.lift(page);
  assert.ok(out.length < 90000 && page.length > 890000, `the page is ${out.length} characters, it was ${page.length} (the inline document stays: 80k)`);
  const ids = [...out.matchAll(/\/api\/app\/website\/preview-file\/([a-f0-9]{40})/g)].map(m => m[1]);
  assert.equal(ids.length, 5, 'the picture (twice), the clip, the engine and the model');
  assert.equal(ids[0], ids[4], 'one file, one id, however often the page uses it');
  assert.deepEqual(ids.map(id => FILES.get(id).type), ['image/png', 'video/mp4', 'text/javascript', 'model/gltf-binary', 'image/png']);
  assert.ok(FILES.get(ids[3]).buf.equals(GLB), 'the model, byte for byte');
  assert.ok(out.includes(uri('image/png', TINY)), 'a small picture stays inline');
  assert.ok(out.includes(uri('text/html', HTML)), 'a document is never served from this app');
  assert.equal(FILES.lift('<p>hi</p>'), '<p>hi</p>');
});

test('a lifted file is served without a session, a clip in ranges, nothing for an unknown id -- and never runs as a page of this app', async () => {
  const builder = await startFixtureBuilder({});
  const app = await startApp({ seed: { website_project_links: [], workspace_members: [] }, people: {}, builderUrl: builder.url });
  try {
    const FILES = files();
    const [, id] = /preview-file\/([a-f0-9]{40})/.exec(FILES.lift(`<video src="${uri('video/mp4', MP4)}">`));
    const url = app.base + FILES.PATH + id;
    let r = await fetch(url); const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(r.status, 200); assert.ok(buf.equals(MP4)); assert.equal(r.headers.get('content-type'), 'video/mp4');
    assert.equal(r.headers.get('accept-ranges'), 'bytes'); assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.match(r.headers.get('content-security-policy'), /sandbox/); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    r = await fetch(url, { headers: { range: 'bytes=0-1' } });
    assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), `bytes 0-1/${MP4.length}`); assert.deepEqual([...Buffer.from(await r.arrayBuffer())], [0, 0]);
    r = await fetch(url, { headers: { range: 'bytes=-4' } });
    assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), `bytes ${MP4.length - 4}-${MP4.length - 1}/${MP4.length}`);
    r = await fetch(url, { headers: { range: `bytes=${MP4.length + 5}-` } }); assert.equal(r.status, 416);
    for (const bad of ['0'.repeat(40), 'nope', id.slice(0, 39)]) assert.equal((await fetch(app.base + FILES.PATH + bad)).status, 404, bad);
  } finally { await app.stop(); await builder.stop(); }
});
