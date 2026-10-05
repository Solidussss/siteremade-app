// THE CREATIVE WEBSITE EDITOR -- the Website view's editing panel for a CREATIVE website (kind 'creative' from the
// builder's own project). The website preview stays the main thing on screen; this panel is a compact list of the page's
// scenes and, for the scene chosen, only what can be done to what is in it: its words, its pictures, its 3D model, its
// colour and composition -- and, for the whole page, today's layout rules and an AI redesign.
//
// The app is the control surface. Every change goes through the builder (routes/website-bridge.js
// /api/app/website/projects/:id/creative/*), which edits the REAL Creative project, validates it, saves a DRAFT, prices
// every paid action and runs it exactly once. Nothing here renders, plans or prices anything: a cost shown here is the
// builder's quote, shown beside the action it belongs to, confirmed before anything is spent. Free changes say so.
// An upload is converted to PNG in this browser (the builder decodes only PNG) and MEASURED BY THE BUILDER -- nothing
// this page says about a picture is trusted. The 3D model's cinematic still is drawn by the builder's own 3D engine page
// in a hidden sandboxed frame and handed back here (postMessage), then sent to the builder, which checks the file itself.
(function () {
  'use strict';
  // drafts: what the owner is typing and has not saved -- keyed text:<scene>:<field>, ask:<scene>, site -- kept here (never in the
  // DOM alone, never in storage) so no redraw can lose it; html: the markup each part was last drawn with
  var ED = { projectId: null, revision: null, outline: null, jobs: [], scene: null, open: null, busy: false, msg: '', tone: '', pending: null, poll: null, loadedFor: '', drafts: {}, html: {}, fontOpen: null };
  var qs = function (s, el) { return (el || document).querySelector(s); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>'"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]; }); };
  var base = function () { return '/api/app/website/projects/' + encodeURIComponent(ED.projectId) + '/creative'; };
  function call(method, url, body) {
    return fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, ok: r.ok && d.ok !== false, body: d }; }); })
      .catch(function () { return { status: 0, ok: false, body: { message: 'The SiteRemade builder couldn’t be reached. Nothing was changed.' } }; });
  }
  var PRICE = { 'ai-text': 'AI rewrite', 'ai-scene': 'Redesign this scene with AI', 'ai-rebuild': 'Rebuild scenes with AI', 'ai-site': 'Redesign the whole page with AI', model3d: 'Make interactive 3D', motion: 'Add cinematic motion', motion3d: 'Make cinematic video from 3D' };
  var SOURCE = { upload: 'your upload', picked: 'picked from the web', web: 'from the web', derived: 'made by SiteRemade' };

  // ---- loading
  function load(force) {
    var cw = typeof canonicalWebsite !== 'undefined' ? canonicalWebsite : null; var c = cw && cw.status === 'ready' ? cw.project : null;
    if (!c || c.kind !== 'creative') return Promise.resolve();
    var key = c.projectId + ':' + c.revision;
    if (!force && ED.loadedFor === key) return Promise.resolve();
    ED.projectId = c.projectId; ED.loadedFor = key;
    return call('GET', base()).then(function (r) {
      if (!r.ok) { say(r.body.message || 'Your Creative page couldn’t be loaded for editing.', 'error'); return; }
      ED.outline = r.body.outline; ED.revision = r.body.revision; ED.jobs = r.body.jobs || [];
      if (ED.focusAsset) { var fa = ED.focusAsset; ED.focusAsset = null; var hit = ED.outline.scenes.find(function (s) { return s.pictures.some(function (p) { return p.assetId === fa || p.assetId === 'c-' + fa; }); }); if (hit) { ED.scene = hit.id; ED.open = 'pic:' + (hit.pictures.find(function (p) { return p.assetId === fa || p.assetId === 'c-' + fa; }) || {}).layerId; } }
      if (!ED.scene || !ED.outline.scenes.some(function (s) { return s.id === ED.scene; })) ED.scene = ED.outline.scenes[0] ? ED.outline.scenes[0].id : null;
      if (Number.isFinite(r.body.creditsRemaining)) credits(r.body.creditsRemaining);
      followJobs(); draw();
    });
  }
  function credits(n) { try { if (typeof workspaceCredits !== 'undefined' && workspaceCredits.data) { workspaceCredits.data.remaining = n; if (typeof safeRender === 'function' && typeof renderWorkspaceCredits === 'function') safeRender('workspace-credits', renderWorkspaceCredits); } } catch (e) { /* display only */ } }
  // after a saved change: the builder's new draft -- the summary (draft chip, Publish), the preview and this outline
  function afterChange(r, okMsg, draft) {
    if (Number.isFinite(r.body.creditsRemaining)) credits(r.body.creditsRemaining);
    var summary = (r.body.changeSummary || []).join(' · ') + ((r.body.fitted || []).length ? ': ' + r.body.fitted.join('; ') + '.' : '');
    // (nothing needed changing: nothing was saved -- no new draft)
    if (r.body.unchanged) { say((summary || 'Nothing needed changing').replace(/[.!]?$/, '.') + ' Nothing was saved. No credits were used.', 'success'); ED.open = null; ED.pending = null; draw(); return; }
    if (draft) delete ED.drafts[draft]; // (the change it was typed for is saved)
    var cost = Number.isFinite(r.body.creditsCharged) && r.body.creditsCharged > 0 ? ' This used ' + r.body.creditsCharged + ' credit' + (r.body.creditsCharged === 1 ? '' : 's') + '.' : ' No credits were used.';
    say((summary || okMsg || 'Saved.') + ' Saved as a draft — your published website hasn’t changed.' + cost, 'success');
    ED.open = null; ED.pending = null;
    var p = typeof loadCanonicalWebsite === 'function' ? loadCanonicalWebsite(true) : Promise.resolve();
    return Promise.resolve(p).then(function () { return load(true); });
  }
  function say(m, tone) { ED.msg = m || ''; ED.tone = tone || ''; var f = qs('#ceFeedback'); if (f) { f.textContent = ED.msg; f.className = 'ce-feedback' + (ED.tone ? ' is-' + ED.tone : ''); } }
  function failed(r) {
    if (r.status === 409 && r.body.code === 'revision_conflict') { say('Your website changed since this panel loaded. It has been refreshed — nothing was changed.', 'error'); return load(true); }
    say(r.body.message || 'That didn’t go through. Nothing was changed.', 'error');
  }

  // ---- free changes
  function edit(op, okMsg, draft) {
    if (ED.busy) return; ED.busy = true; draw();
    return call('POST', base() + '/edit', { baseRevision: ED.revision, op: op }).then(function (r) { ED.busy = false; if (!r.ok) { failed(r); draw(); return; } return afterChange(r, okMsg, draft); });
  }
  // ---- paid actions: the builder's quote -> the owner confirms -> start (once) -> follow the job
  function quote(action, extra, draft) {
    if (ED.busy) return; ED.busy = true; say('Asking SiteRemade for the cost…'); draw();
    return call('POST', base() + '/quote', Object.assign({ action: action }, extra || {})).then(function (r) {
      ED.busy = false;
      if (!r.ok) { say(r.body.message || 'That isn’t available right now. Nothing was charged.', 'error'); draw(); return; }
      if (r.body.reuse) {
        // (already made: reused for free -- a 3D model is placed in this scene, a clip is already on its picture)
        if (action === 'model3d' && r.body.modelId) return edit({ type: 'model-place', modelId: r.body.modelId, sectionId: ED.scene }, 'Placed your existing 3D model — free.');
        say(r.body.message || 'Already made — kept for free.', 'success'); draw(); return;
      }
      ED.pending = { action: action, extra: extra || {}, quote: r.body.quote, enough: r.body.enough, needsRender: !!r.body.needsRender, draft: draft || null };
      say(''); draw();
    });
  }
  function confirmPending() {
    var p = ED.pending; if (!p || ED.busy) return; ED.busy = true; draw();
    var send = function (render) {
      say(p.action === 'model3d' ? 'Starting your 3D model…' : /^motion/.test(p.action) ? 'Starting your cinematic clip…' : 'Working on it — this can take a minute.');
      return call('POST', base() + '/start', Object.assign({ quoteId: p.quote.id, baseRevision: ED.revision }, render ? { render: render } : {})).then(function (r) {
        ED.busy = false; ED.pending = null;
        if (!r.ok) { failed(r); draw(); return; }
        if (r.body.job) { say(r.body.reused ? 'Already being made — following it.' : (r.body.job.kind === 'model3d' ? 'Your 3D model is being made. You can keep working; it joins the page as a draft when it’s ready.' : 'Your cinematic clip is being made. You can keep working; it joins the picture as a draft when it’s ready.'), 'info'); load(true); return; }
        return afterChange(r, null, p.draft);
      });
    };
    if (p.needsRender) return still().then(send, function () { ED.busy = false; say('The still of your 3D model couldn’t be drawn in this browser. Nothing was charged.', 'error'); draw(); });
    return send(null);
  }
  // the 3D model's still: the builder's engine page in a hidden sandboxed frame posts the PNG back
  function still() {
    return new Promise(function (resolve, reject) {
      var f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1;
      f.style.cssText = 'position:fixed;left:-10000px;top:0;width:1280px;height:720px;border:0;opacity:0;pointer-events:none';
      var done = false; var finish = function (fn, v) { if (done) return; done = true; window.removeEventListener('message', on); clearTimeout(t); f.remove(); fn(v); };
      var on = function (e) { if (e.source !== f.contentWindow || !e.data || e.data.type !== 'sr-3d-still') return; if (e.data.dataUrl && /^data:image\/png;base64,/.test(e.data.dataUrl)) finish(resolve, e.data.dataUrl); else finish(reject, new Error(e.data.error || 'still')); };
      var t = setTimeout(function () { finish(reject, new Error('timeout')); }, 90000);
      window.addEventListener('message', on); f.src = base() + '/still'; document.body.appendChild(f);
    });
  }
  function followJobs() {
    var active = (ED.jobs || []).some(function (j) { return !j.terminal; });
    if (!active) { if (ED.poll) { clearTimeout(ED.poll); ED.poll = null; } return; }
    if (ED.poll) return;
    ED.poll = setTimeout(function () {
      ED.poll = null;
      call('GET', base() + '/jobs').then(function (r) {
        if (!r.ok) { ED.poll = setTimeout(followJobs, 6000); return; }
        var was = ED.revision; ED.jobs = r.body.jobs || [];
        if (Number.isInteger(r.body.revision) && r.body.revision !== was) { say('Ready — added to your page as a draft. Review it, then publish when you’re happy.', 'success'); var p = typeof loadCanonicalWebsite === 'function' ? loadCanonicalWebsite(true) : null; Promise.resolve(p).then(function () { load(true); }); return; }
        draw(); followJobs();
      });
    }, 3000);
  }
  // ---- an upload: converted to PNG here (scaled so its longest side is at most 2400 px); the builder measures it
  // a .glb read as it is (no conversion) and sent to the builder, which checks it as every 3D model
  function uploadModel(file, sceneId) {
    if (!file) return;
    if (!/\.glb$/i.test(file.name || '') && file.type !== 'model/gltf-binary') { say('Choose a .glb 3D model file.', 'error'); return; }
    if (file.size > 8 * 1024 * 1024) { say('That 3D model is larger than 8 MB. Choose a lighter one.', 'error'); return; }
    ED.busy = true; say('Uploading your 3D model…'); draw();
    var fr = new FileReader();
    fr.onload = function () {
      var glb = 'data:model/gltf-binary;base64,' + String(fr.result || '').replace(/^data:[^,]*,/, '');
      call('POST', base() + '/model-upload', { baseRevision: ED.revision, glb: glb, sceneId: sceneId, title: String(file.name || '').replace(/\.glb$/i, '').slice(0, 120) }).then(function (r) { ED.busy = false; if (!r.ok) { failed(r); draw(); return; } afterChange(r, 'Your 3D model is on the page.'); });
    };
    fr.onerror = function () { ED.busy = false; say('That file could not be read.', 'error'); draw(); };
    fr.readAsDataURL(file);
  }
  function upload(file, target) {
    if (!file || !/^image\//.test(file.type)) { say('Choose a picture file.', 'error'); return; }
    if (file.size > 25 * 1024 * 1024) { say('That file is too large. Choose a picture under 25 MB.', 'error'); return; }
    ED.busy = true; say('Preparing your picture…'); draw();
    var url = URL.createObjectURL(file); var img = new Image();
    img.onload = function () {
      var k = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight)); var cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(img.naturalWidth * k)); cv.height = Math.max(1, Math.round(img.naturalHeight * k));
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height); URL.revokeObjectURL(url);
      var png = cv.toDataURL('image/png');
      say('Uploading your picture…');
      call('POST', base() + '/upload', Object.assign({ baseRevision: ED.revision, png: png, title: String(file.name || '').replace(/\.[a-z0-9]+$/i, '').slice(0, 120) }, target || {})).then(function (r) { ED.busy = false; if (!r.ok) { failed(r); draw(); return; } if (target && (target.after || target.into) && r.body.assetId) ED.focusAsset = r.body.assetId; afterChange(r, 'Your picture is on the page.'); });
    };
    img.onerror = function () { URL.revokeObjectURL(url); ED.busy = false; say('That picture couldn’t be read in this browser.', 'error'); draw(); };
    img.src = url;
  }

  // ---- drawing
  function sceneOf(id) { return (ED.outline && ED.outline.scenes || []).find(function (s) { return s.id === id; }) || null; }
  function costRow() {
    var p = ED.pending; if (!p) return '';
    var n = p.quote && p.quote.credits; var label = PRICE[p.action] || 'This change';
    return '<div class="ce-confirm" role="group" aria-label="Confirm cost"><p><strong>' + esc(label) + '</strong> uses <strong>' + esc(n) + ' credit' + (n === 1 ? '' : 's') + '</strong>' +
      (p.quote && p.quote.items && p.quote.items[0] && p.quote.items[0].optional ? ' — only if it is made' : '') + '.' + (p.enough === false ? ' Your balance isn’t enough — add credits first.' : '') + '</p>' +
      '<div class="ce-row"><button type="button" class="ce-btn ce-primary" data-ce="confirm"' + (p.enough === false ? ' data-off="1"' : '') + '>Confirm · ' + esc(n) + ' credit' + (n === 1 ? '' : 's') + '</button><button type="button" class="ce-btn" data-ce="cancel">Cancel</button></div></div>';
  }
  function textBlock(s) {
    var fields = [['kicker', 'Small heading', 70], ['heading', 'Headline', 110], ['body', 'Paragraph', 520]];
    return '<div class="ce-group"><h3>Words</h3>' + fields.filter(function (f) { return f[0] !== 'kicker' || s.text.kicker; }).map(function (f) {
      var key = 'text:' + f[0]; var v = s.text[f[0]] || '';
      if (ED.open === key) return '<div class="ce-item is-open"><label class="ce-label" for="ceText">' + esc(f[1]) + '</label><textarea id="ceText" data-draft="text:' + esc(s.id) + ':' + f[0] + '" rows="' + (f[0] === 'body' ? 4 : 2) + '" maxlength="' + f[2] + '">' + esc(v) + '</textarea>' +
        '<div class="ce-row"><button type="button" class="ce-btn ce-primary" data-ce="save-text" data-field="' + f[0] + '">Save · free</button>' + (s.actions.indexOf('ai-text') >= 0 && f[0] !== 'kicker' ? '<button type="button" class="ce-btn" data-ce="ai-text" data-field="' + f[0] + '">AI rewrite…</button>' : '') + '<button type="button" class="ce-btn ce-quiet" data-ce="close">Cancel</button></div></div>';
      return '<button type="button" class="ce-item" data-ce="open" data-key="' + key + '"><span class="ce-label">' + esc(f[1]) + '</span><span class="ce-value">' + esc(v || 'Empty') + '</span></button>';
    }).join('') +
      // (the same words, set again by the page's own typography -- free, no AI)
      (s.actions.indexOf('text-layout') >= 0 && ED.open == null ? '<div class="ce-row"><button type="button" class="ce-btn" data-ce="free" data-op="text-layout">Fix text layout — free</button></div>' : '') + '</div>';
  }
  // ADD A PICTURE: into THIS scene, beside its words (the builder composes the scene again around it -- a page that holds
  // as many scenes as it can still takes one), or as its own new scene right after this one, shown big; a new upload, or
  // a picture this project already has that is not on the page. Both free.
  function addRow(s) {
    var a = s.actions || []; var into = a.indexOf('picture-add') >= 0, after = a.indexOf('picture-scene') >= 0;
    var carried = (s.pictures || []).some(function (p) { return p.carried; });
    var why = carried ? '<p class="ce-note">Your product floats through this scene, so it holds no other picture. Choose another scene above to add one there.</p>' : '';
    if (!into && !after) return why || '<p class="ce-note">This scene shows as many pictures as it can, and the page has as many scenes as it can hold. Replace a picture to show a new one.</p>';
    var spare = (ED.outline.pictures || []).filter(function (x) { return !x.onPage; });
    var pick = function (k, label) { return spare.length ? '<select class="ce-select" data-ce="' + k + '" aria-label="' + label + '"><option value="">Or one you already have…</option>' + spare.map(function (x) { return '<option value="' + esc(x.assetId) + '">' + esc((x.source && x.source.title) || 'Picture') + '</option>'; }).join('') + '</select>' : ''; };
    return (into ? '' : why) + (into ? '<div class="ce-row ce-add"><label class="ce-btn ce-primary ce-file">+ Add a picture to this scene<input type="file" accept="image/*" data-ce="upload-into"></label>' + pick('place-into', 'Add a picture this website already has to this scene') +
        '</div><p class="ce-note">It goes in beside this scene’s words, and the scene is laid out again around it. Free.</p>' : '') +
      (after ? '<div class="ce-row ce-add"><label class="ce-btn ce-file">+ Add as a new scene after this one<input type="file" accept="image/*" data-ce="upload-after"></label>' + pick('place-after', 'Add a picture this website already has as a new scene') +
        '</div><p class="ce-note">Shown big in its own scene. Nothing else on the page moves. Free.</p>' : '');
  }
  // THE SCENE'S CINEMATIC CLIP, on its own: where it plays, and taking it off -- apart from the pictures, so a picture
  // removed or added again never leaves the clip doubled or lost
  // UNDO: one step back (free) -- the page as it was before the last change
  function undoRow() {
    var u = ED.outline && ED.outline.undo; if (!u || !u.steps) return '';
    return '<div class="ce-row"><button type="button" class="ce-btn ce-quiet" data-ce="undo"' + (ED.busy ? ' disabled' : '') + '>↶ Undo last change · free</button></div>' + (u.last ? '<p class="ce-note">Last change: ' + esc(u.last) + '</p>' : '');
  }
  function clipBlock(s) {
    var k = s.clips || []; if (!k.length) return '';
    return '<div class="ce-group"><h3>Cinematic clip</h3>' + k.map(function (c) {
      return '<div class="ce-item is-open"><span class="ce-label">' + esc(c.title || 'Cinematic clip') + '</span><span class="ce-value">' + (c.where === 'picture' ? 'Plays inside its picture' : 'Plays full-screen behind this scene') + ' · on phones the whole clip shows</span>' +
        ((c.actions || []).indexOf('motion-remove') >= 0 ? '<div class="ce-row"><button type="button" class="ce-btn ce-quiet" data-ce="free" data-op="motion-remove" data-asset="' + esc(c.assetId) + '">Take the clip off · free</button></div>' : '') + '</div>';
    }).join('') + '</div>';
  }
  function pictureBlock(s) {
    if (!s.pictures.length) return '<div class="ce-group"><h3>Pictures</h3><p class="ce-note">This scene is carried by its words and colour.</p>' + addRow(s) + '</div>';
    return '<div class="ce-group"><h3>Pictures</h3>' + s.pictures.map(function (p) {
      var key = 'pic:' + p.layerId; var src = p.source || {}; var a = p.actions || [];
      var head = '<span class="ce-label">' + esc(src.title || 'Picture') + (p.callback ? ' · returns as the closing callback' : '') + (p.carried ? ' · floats through these scenes' : '') + '</span><span class="ce-value">' + esc(SOURCE[src.kind] || 'picture') + (src.cutout ? ' · cut-out' : '') + (p.clip ? ' · moves (cinematic clip)' : '') + (p.model ? ' · has a 3D model' : '') + '</span>';
      if (ED.open !== key) return '<button type="button" class="ce-item" data-ce="open" data-key="' + key + '">' + head + '</button>';
      var others = (ED.outline.pictures || []).filter(function (x) { return x.assetId !== p.assetId && x.source && x.source.rootId !== (src.rootId || ''); });
      return '<div class="ce-item is-open">' + head +
        (p.layerId ? '<div class="ce-row"><label class="ce-btn ce-file">Upload a new picture<input type="file" accept="image/*" data-ce="upload" data-layer="' + esc(p.layerId) + '"></label>' +
        (others.length ? '<select class="ce-select" data-ce="replace" data-layer="' + esc(p.layerId) + '" aria-label="Replace with a picture from this project"><option value="">Use another picture…</option>' + others.map(function (x) { return '<option value="' + esc(x.assetId) + '">' + esc((x.source && x.source.title) || x.assetId) + (x.onPage ? ' (already on the page)' : '') + '</option>'; }).join('') + '</select>' : '') +
        '<button type="button" class="ce-btn ce-quiet" data-ce="remove-pic" data-layer="' + esc(p.layerId) + '">Remove · free</button></div>' : '') +
        '<div class="ce-row">' +
        (a.indexOf('model3d') >= 0 ? '<button type="button" class="ce-btn" data-ce="paid" data-action="model3d" data-asset="' + esc(p.assetId) + '">Make interactive 3D…</button>' : '') +
        (a.indexOf('model-lathe') >= 0 ? '<button type="button" class="ce-btn" data-ce="free" data-op="model-lathe" data-asset="' + esc(p.assetId) + '">Make 3D from this picture · free</button>' : '') +
        (a.indexOf('model3d-used') >= 0 ? '<p class="ce-note">This page has made its 3D model (a Creative page makes one). Show it in any scene for free, or upload your own .glb in the 3D section below — free.</p>' : '') +
        (a.indexOf('model3d-reuse') >= 0 ? '<button type="button" class="ce-btn" data-ce="paid" data-action="model3d" data-asset="' + esc(p.assetId) + '">Show its 3D model here · free</button>' : '') +
        (a.indexOf('motion') >= 0 ? '<button type="button" class="ce-btn" data-ce="paid" data-action="motion" data-asset="' + esc(p.assetId) + '" data-layer="' + esc(p.layerId) + '">Add cinematic motion…</button>' : '') +
        (a.indexOf('motion-new') >= 0 ? '<button type="button" class="ce-btn" data-ce="paid" data-action="motion" data-fresh="1" data-asset="' + esc(p.assetId) + '" data-layer="' + esc(p.layerId) + '">Make a new clip…</button>' : '') +
        (a.indexOf('motion-remove') >= 0 ? '<button type="button" class="ce-btn ce-quiet" data-ce="free" data-op="motion-remove" data-asset="' + esc(p.assetId) + '">Stop the motion · free</button>' : '') +
        (a.indexOf('motion-restore') >= 0 ? '<button type="button" class="ce-btn" data-ce="free" data-op="motion-restore" data-asset="' + esc(p.assetId) + '">Put the clip back · free</button>' : '') +
        '</div><button type="button" class="ce-btn ce-quiet" data-ce="close">Done</button></div>';
    }).join('') + addRow(s) + '</div>';
  }
  // (the owner's own 3D model, a .glb file: shown in this scene turning as the page scrolls -- free)
  function ownModelRow(s) {
    return '<div class="ce-row ce-add"><label class="ce-btn ce-file">Upload your own 3D model (.glb)<input type="file" data-ce="upload-model"></label></div>' +
      '<p class="ce-note">' + (s.models.length ? 'It takes this scene’s 3D place' : 'It stands where this scene’s picture is') + ' and turns as the page scrolls. Up to 8 MB. Free.</p>';
  }
  function modelBlock(s) {
    if (!s.models.length) {
      var all = ED.outline.models || []; var many = all.length > 1;
      return '<div class="ce-group"><h3>3D</h3>' + all.map(function (m, i) { return '<button type="button" class="ce-item" data-ce="free" data-op="model-place" data-model="' + esc(m.id) + '"><span class="ce-label">Show ' + (many ? '3D model ' + (i + 1) + (m.title ? ' (' + esc(m.title) + ')' : '') : 'your 3D model') + ' in this scene</span><span class="ce-value">free — no new model is made</span></button>'; }).join('') + ownModelRow(s) + '</div>';
    }
    var others = ED.outline.scenes.filter(function (x) { return x.id !== s.id && !x.models.length; });
    return '<div class="ce-group"><h3>3D model</h3>' + s.models.map(function (m) {
      return '<div class="ce-item is-open"><span class="ce-label">Interactive 3D model</span>' +
        '<div class="ce-row"><label class="ce-field">Size<input type="range" min="0.6" max="3" step="0.1" value="' + esc(m.distance || 1) + '" data-ce="model-size" data-msc="' + esc(m.id) + '" aria-label="Distance from the camera (larger is further away)"></label>' +
        '<label class="ce-field">Turn<input type="range" min="-180" max="180" step="5" value="' + esc(m.azimuth || 0) + '" data-ce="model-turn" data-msc="' + esc(m.id) + '"></label></div>' +
        '<div class="ce-row"><select class="ce-select" data-ce="model-comp" data-msc="' + esc(m.id) + '" aria-label="How the model moves">' + (ED.outline.threeDCompositions || []).map(function (k) { return '<option value="' + esc(k) + '"' + (k === m.composition ? ' selected' : '') + '>' + esc(k.replace(/-/g, ' ')) + '</option>'; }).join('') + '</select>' +
        (others.length ? '<select class="ce-select" data-ce="model-move" data-msc="' + esc(m.id) + '" aria-label="Move to another scene"><option value="">Move to…</option>' + others.map(function (x) { return '<option value="' + esc(x.id) + '">' + esc(x.name) + '</option>'; }).join('') + '</select>' : '') +
        '<button type="button" class="ce-btn ce-quiet" data-ce="free" data-op="model-remove" data-msc="' + esc(m.id) + '">Take off · free</button></div>' +
        ((m.actions || []).indexOf('motion-from-3d') >= 0 ? '<div class="ce-row"><button type="button" class="ce-btn" data-ce="paid" data-action="motion3d">Make cinematic video from 3D…</button></div>' : '') + '</div>';
    }).join('') + ownModelRow(s) + '</div>';
  }
  // ---- how the scene moves (its headline's entrance, its pictures' move) and the page's set piece -- free
  var WORDS = { '3d': '3D block', blur: 'Blur in', pop: 'Pop', split: 'Split from the sides', cascade: 'Letters cascade', flip: 'Letters flip', type: 'Typed out', sweep: 'Colour sweep', fill: 'Fills as it is read', rise: 'Rise' };
  var PICTURE = { grow: 'Grows to full', tilt: 'Tilts up', drift: 'Drifts', turn: 'Turns in', rush: 'Rushes in', pixel: 'Pixel reveal', still: 'Stays still' };
  var SIGN = { pour: 'Pour', spotlight: 'Spotlight', typewall: 'Type wall' };
  function motionRows(s) {
    var M = ED.outline.moves; if (!M || (s.actions || []).indexOf('scene-move') < 0) return '';
    var mv = s.move || {};
    var sel = function (key, list, names, label) { return '<select class="ce-select" data-ce="move-' + key + '" aria-label="' + label + '"><option value="">' + label + ': ' + (mv[key] ? esc(names[mv[key]] || mv[key]) : 'automatic') + '</option>' + (mv[key] ? '<option value="">Automatic</option>' : '') + list.map(function (k) { return '<option value="' + esc(k) + '">' + esc(names[k] || k) + '</option>'; }).join('') + '</select>'; };
    var sig = (s.actions || []).indexOf('signature') >= 0 && ((s.signatures || []).length || s.signature)
      ? '<div class="ce-row"><select class="ce-select" data-ce="signature" aria-label="Set piece"><option value="">Set piece: ' + (s.signature ? esc(SIGN[s.signature] || s.signature) : 'none here') + '</option>' + (s.signature ? '<option value="none">No set piece</option>' : '') + (s.signatures || []).filter(function (k) { return k !== s.signature; }).map(function (k) { return '<option value="' + esc(k) + '">' + esc(SIGN[k] || k) + '</option>'; }).join('') + '</select><span class="ce-note">free</span></div>' : '';
    return '<div class="ce-row">' + sel('words', M.words, WORDS, 'Headline') + '</div><div class="ce-row">' + sel('picture', M.picture, PICTURE, 'Pictures') + '<span class="ce-note">free</span></div>' + sig;
  }
  function sceneBlock(s) {
    var pal = ED.outline.palette || [];
    return '<div class="ce-group"><h3>Scene</h3>' +
      '<div class="ce-row ce-swatches" role="group" aria-label="Scene colour (from your page’s own palette)">' + pal.map(function (p) { return '<button type="button" class="ce-swatch' + (p.hex === s.background ? ' is-on' : '') + '" data-ce="colour" data-role="' + esc(p.role) + '" style="--sw:' + esc(p.hex) + '" title="' + esc(p.label) + '"><span class="sr-only">' + esc(p.label) + '</span></button>'; }).join('') + '<span class="ce-note">colour · free</span></div>' +
      (s.compositions.length ? '<div class="ce-row"><select class="ce-select" data-ce="composition" aria-label="Composition"><option value="">Composition: ' + esc(s.composition.replace(/-/g, ' ')) + '</option>' + s.compositions.map(function (k) { return '<option value="' + esc(k.id) + '" title="' + esc(k.label) + '">' + esc(k.id.replace(/-/g, ' ')) + '</option>'; }).join('') + '</select><span class="ce-note">free</span></div>' : '') +
      motionRows(s) +
      (s.actions.indexOf('scene-up') >= 0 || s.actions.indexOf('scene-down') >= 0 ? '<div class="ce-row">' + (s.actions.indexOf('scene-up') >= 0 ? '<button type="button" class="ce-btn" data-ce="free" data-op="scene-order" data-dir="up">↑ Move up · free</button>' : '') + (s.actions.indexOf('scene-down') >= 0 ? '<button type="button" class="ce-btn" data-ce="free" data-op="scene-order" data-dir="down">↓ Move down · free</button>' : '') + '</div>' : '') +
      (s.actions.indexOf('scene-remove') >= 0 ? '<div class="ce-row"><button type="button" class="ce-btn ce-quiet" data-ce="free" data-op="scene-remove">Remove this scene · free</button></div>' : '') +
      (s.actions.indexOf('ai-scene') >= 0 ? '<div class="ce-row"><input class="ce-input" id="ceSceneAsk" data-draft="ask:' + esc(s.id) + '" maxlength="400" placeholder="Optional: what should change?" aria-label="What should change in this scene"><button type="button" class="ce-btn" data-ce="ai-scene">Redesign this scene…</button></div>' : '') + '</div>';
  }
  function jobsBlock() {
    var live = (ED.jobs || []).filter(function (j) { return !j.terminal; }); if (!live.length) return '';
    return '<div class="ce-jobs" role="status">' + live.map(function (j) { return '<p><span class="ce-dot" aria-hidden="true"></span>' + esc(j.message || (j.kind === 'model3d' ? 'Creating 3D model…' : 'Creating cinematic clip…')) + '</p>'; }).join('') + '</div>';
  }
  // ---- fonts: the page's typefaces (the builder's registry -- ids only). A pairing, or a face per role, from a menu grouped
  // by category in which every name is shown in its own face; a face's file is fetched only when its name is on screen.
  var ROLE_NAME = { headline: 'Headlines', body: 'Text', label: 'Labels' };
  function fontOf(id) { var f = ED.outline && ED.outline.fonts; return f && f.fonts.find(function (x) { return x.id === id; }) || null; }
  function sample(f, text) { return '<span class="ce-fontsample" data-ff="' + esc(f ? f.stack : '') + '">' + esc(text) + '</span>'; }
  function fontsBlock() {
    var F = ED.outline.fonts; if (!F || !(ED.outline.actions || []).some(function (a) { return a === 'fonts'; })) return '';
    var cur = F.current || {};
    var presets = '<div class="ce-presets" role="group" aria-label="Font pairings">' + F.presets.map(function (p) {
      var on = cur.preset === p.id; return '<button type="button" class="ce-preset' + (on ? ' is-on' : '') + '" data-ce="font-preset" data-preset="' + esc(p.id) + '" aria-pressed="' + on + '">' + sample(fontOf(p.headline), p.name) + '</button>'; }).join('') + '</div>';
    var rows = ['headline', 'body', 'label'].map(function (r) {
      var f = fontOf(cur[r]); var open = ED.fontOpen === r;
      var btn = '<button type="button" class="ce-fontrow' + (open ? ' is-open' : '') + '" data-ce="font-open" data-role="' + r + '" aria-haspopup="listbox" aria-expanded="' + open + '"><span class="ce-label">' + ROLE_NAME[r] + '</span>' + (f ? sample(f, f.label) : '<span class="ce-fontsample">The page’s own</span>') + '<span class="ce-chev" aria-hidden="true">▾</span></button>';
      if (!open) return btn;
      var pickedId = cur[r] || '';
      var opt = function (id, label, f2) { var sel = id === pickedId; return '<button type="button" role="option" class="ce-fontopt' + (sel ? ' is-on' : '') + '" aria-selected="' + sel + '" data-ce="font-pick" data-role="' + r + '" data-font="' + esc(id) + '">' + (f2 ? sample(f2, label) : '<span class="ce-fontsample">' + esc(label) + '</span>') + (f2 && f2.source === 'system' ? '<span class="ce-fonttag">on the device</span>' : '') + '<span class="ce-tick" aria-hidden="true">' + (sel ? '✓' : '') + '</span></button>'; };
      return btn + '<div class="ce-fontmenu" role="listbox" aria-label="' + ROLE_NAME[r] + ' font" id="ceFontMenu">' + opt('', 'The page’s own', null) +
        F.categories.map(function (c) { return '<div class="ce-fontcat" role="group" aria-label="' + esc(c.label) + '"><p class="ce-fontcatname">' + esc(c.label) + '</p>' + c.fonts.map(function (id) { var f2 = fontOf(id); return f2 ? opt(id, f2.label, f2) : ''; }).join('') + '</div>'; }).join('') + '</div>';
    }).join('');
    return '<div class="ce-group ce-fonts"><h3>Fonts</h3><p class="ce-note">Pairings · free</p>' + presets + rows + '</div>';
  }
  // the faces the picker may show: declared once, under the same names the website uses (the builder's stacks name them);
  // a face is only fetched when a name set in it is drawn on screen (below)
  var facesDeclared = false;
  function declareFaces() {
    var F = ED.outline && ED.outline.fonts; if (facesDeclared || !F) return; facesDeclared = true;
    var css = F.fonts.filter(function (f) { return f.specimen; }).map(function (f) { return '@font-face{font-family:"SR ' + f.label.replace(/["\\]/g, '') + '";font-weight:' + f.specimen.weight + ';font-display:swap;src:url("/api/app/website/fonts/' + encodeURIComponent(f.specimen.file) + '") format("woff2")}'; }).join('');
    var st = document.createElement('style'); st.id = 'ceFontFaces'; st.textContent = css; document.head.appendChild(st);
  }
  var seen = null;
  function showFaces(box) {
    var els = box.querySelectorAll('.ce-fontsample[data-ff]'); if (!els.length) return; declareFaces();
    var apply = function (el) { if (el.dataset.ff && !el.style.fontFamily) el.style.fontFamily = el.dataset.ff; };
    if (typeof IntersectionObserver !== 'function') { for (var i = 0; i < els.length; i++) apply(els[i]); return; }
    if (!seen) seen = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { apply(e.target); seen.unobserve(e.target); } }); }, { rootMargin: '120px' });
    for (var j = 0; j < els.length; j++) if (!els[j].style.fontFamily) seen.observe(els[j]);
  }
  function draw() {
    var box = qs('#creativeEditor'); if (!box || box.hidden || !ED.outline) return;
    var pill = qs('#creativeEditorPill'); if (pill) pill.textContent = ED.busy ? 'Working…' : 'Draft edits';
    // (what the owner is typing, and where: given back if its field has to be drawn again)
    var act = document.activeElement; var typing = act && box.contains(act) && act.dataset && act.dataset.draft ? { key: act.dataset.draft, start: act.selectionStart, end: act.selectionEnd, dir: act.selectionDirection, top: act.scrollTop } : null;
    var s = sceneOf(ED.scene);
    // a part is drawn again only when its markup changed -- a job poll, a credit update or the app's own render that changes
    // nothing leaves the fields (their text, caret and input method) exactly as they are
    var put = function (el, key, html) { if (!el || (ED.html[key] === html && el.childNodes.length)) return; el.innerHTML = html; ED.html[key] = html; };
    put(qs('#ceScenes'), 'scenes', ED.outline.scenes.map(function (x, i) { return '<li><button type="button" class="ce-scene' + (x.id === ED.scene ? ' is-on' : '') + '" data-ce="scene" data-scene="' + esc(x.id) + '" aria-pressed="' + (x.id === ED.scene) + '"><span class="ce-num">' + (i + 1) + '</span><span class="ce-sname">' + esc(x.name) + '</span></button></li>'; }).join(''));
    put(qs('#cePanel'), 'panel', s ? (jobsBlock() + costRow() + undoRow() + textBlock(s) + clipBlock(s) + pictureBlock(s) + modelBlock(s) + sceneBlock(s)) : '');
    put(qs('#ceWhole'), 'whole', fontsBlock() + '<div class="ce-group"><h3>Whole page</h3><div class="ce-row"><button type="button" class="ce-btn" data-ce="free" data-op="reapply-look">Re-apply today’s layout rules · free</button></div>' +
      ((ED.outline.actions || []).indexOf('ai-site') >= 0 ? '<div class="ce-row"><input class="ce-input" id="ceSiteAsk" data-draft="site" maxlength="600" placeholder="Describe a new direction for the whole page" aria-label="Describe a new direction for the whole page"><button type="button" class="ce-btn" data-ce="ai-site">Redesign the page…</button></div>' : '') + '</div>');
    // every free-form field shows the owner's unsaved words when there are any (a field drawn again starts from them)
    var fields = box.querySelectorAll('[data-draft]'); var back = null;
    for (var i = 0; i < fields.length; i++) { var el = fields[i]; var k = el.dataset.draft; if (Object.prototype.hasOwnProperty.call(ED.drafts, k) && el.value !== ED.drafts[k]) el.value = ED.drafts[k]; if (typing && k === typing.key) back = el; }
    if (typing && back && document.activeElement !== back) { try { back.focus({ preventScroll: true }); back.setSelectionRange(typing.start, typing.end, typing.dir || 'none'); back.scrollTop = typing.top; } catch (e) { /* a field that takes no caret */ } }
    showFaces(box);
    qs('#ceFeedback').textContent = ED.msg; qs('#ceFeedback').className = 'ce-feedback' + (ED.tone ? ' is-' + ED.tone : '');
    // (while a change is on its way the actions wait; what the owner is typing never does)
    box.querySelectorAll('button,select,input,textarea').forEach(function (el) { el.disabled = el.hasAttribute('data-off') || (ED.busy && el.dataset.ce !== 'cancel' && !el.hasAttribute('data-draft')); });
  }
  function onInput(e) { var el = e.target; if (el && el.dataset && el.dataset.draft && qs('#creativeEditor').contains(el)) ED.drafts[el.dataset.draft] = el.value; }
  // (a scene's unsaved words belong to that scene: leaving it lets them go -- the whole-page words stay)
  function dropScene(id) { Object.keys(ED.drafts).forEach(function (k) { if (k.split(':')[1] === id) delete ED.drafts[k]; }); }

  // ---- events (one delegated listener)
  function onClick(e) {
    var b = e.target.closest('[data-ce]'); if (!b || !qs('#creativeEditor').contains(b)) return;
    var k = b.dataset.ce; var s = sceneOf(ED.scene);
    if (k === 'scene') { if (b.dataset.scene !== ED.scene) dropScene(ED.scene); ED.scene = b.dataset.scene; ED.open = null; ED.pending = null; say(''); draw(); return; }
    if (k === 'open') { ED.open = b.dataset.key; draw(); var t = qs('#ceText'); if (t) t.focus(); return; }
    if (k === 'close') { if (ED.open && ED.open.indexOf('text:') === 0) delete ED.drafts['text:' + ED.scene + ':' + ED.open.slice(5)]; ED.open = null; draw(); return; }
    if (k === 'cancel') { ED.pending = null; say(''); draw(); return; }
    if (k === 'undo') { if (ED.busy) return; ED.busy = true; say('Undoing your last change…'); draw(); call('POST', base() + '/undo', { baseRevision: ED.revision }).then(function (r) { ED.busy = false; if (!r.ok) { failed(r); draw(); return; } afterChange(r, 'Undone.'); }); return; }
    if (k === 'confirm') { confirmPending(); return; }
    if (k === 'font-open') { ED.fontOpen = ED.fontOpen === b.dataset.role ? null : b.dataset.role; draw(); var m = qs('#ceFontMenu'); var on = m && m.querySelector('.is-on'); if (on) m.scrollTop = Math.max(0, m.scrollTop + on.getBoundingClientRect().top - m.getBoundingClientRect().top - (m.clientHeight - on.offsetHeight) / 2); /* (the current choice, in the middle of the menu) */ return; }
    if (k === 'font-pick') { var op = { type: 'fonts' }; op[b.dataset.role] = b.dataset.font; ED.fontOpen = null; edit(op); return; }
    if (k === 'font-preset') { ED.fontOpen = null; edit({ type: 'fonts', preset: b.dataset.preset }); return; }
    if (k === 'save-text') { var v = qs('#ceText').value; edit({ type: 'text', sceneId: s.id, field: b.dataset.field, value: v }, null, 'text:' + s.id + ':' + b.dataset.field); return; }
    if (k === 'ai-text') { quote('ai-text', { sceneId: s.id, field: b.dataset.field, request: qs('#ceText').value !== (s.text[b.dataset.field] || '') ? 'Use this as the starting point: ' + qs('#ceText').value : '' }, 'text:' + s.id + ':' + b.dataset.field); return; }
    if (k === 'ai-scene') { quote('ai-scene', { sceneId: s.id, request: (qs('#ceSceneAsk') || {}).value || '' }, 'ask:' + s.id); return; }
    if (k === 'ai-site') { var ask = ((qs('#ceSiteAsk') || {}).value || '').trim(); if (!ask) { say('Describe the new direction first.', 'error'); return; } quote('ai-site', { request: ask }, 'site'); return; }
    if (k === 'remove-pic') { edit({ type: 'picture-remove', sceneId: s.id, layerId: b.dataset.layer }); return; }
    if (k === 'colour') { edit({ type: 'colour', sceneId: s.id, role: b.dataset.role }); return; }
    if (k === 'paid') { quote(b.dataset.action, { assetId: b.dataset.asset, sceneId: s.id, layerId: b.dataset.layer, fresh: b.dataset.fresh === '1' }); return; }
    if (k === 'free') {
      var op = b.dataset.op;
      if (op === 'reapply-look') return edit({ type: 'reapply-look' });
      if (op === 'text-layout') return edit({ type: 'text-layout', sceneId: s.id });
      if (op === 'model-place') return edit({ type: 'model-place', modelId: b.dataset.model, sectionId: s.id });
      if (op === 'model-remove') return edit({ type: 'model-remove', modelSceneId: b.dataset.msc });
      if (op === 'model-lathe') return edit({ type: 'model-lathe', sceneId: s.id, assetId: b.dataset.asset });
      if (op === 'scene-order') return edit({ type: 'scene-order', sceneId: s.id, dir: b.dataset.dir === 'up' ? 'up' : 'down' });
      if (op === 'scene-remove') { if (!window.confirm('Remove this scene from the page? Its picture stays in your pictures.')) return; ED.scene = null; return edit({ type: 'scene-remove', sceneId: s.id }); }
      return edit({ type: op, assetId: b.dataset.asset });
    }
  }
  function onChange(e) {
    var el = e.target; if (!el.dataset || !el.dataset.ce || !qs('#creativeEditor').contains(el)) return; var s = sceneOf(ED.scene); var k = el.dataset.ce;
    if (k === 'upload') { upload(el.files && el.files[0], { sceneId: s.id, layerId: el.dataset.layer }); return; }
    if (k === 'upload-after') { upload(el.files && el.files[0], { after: s.id }); return; }
    if (k === 'upload-model') { uploadModel(el.files && el.files[0], s.id); return; }
    if (k === 'upload-into') { upload(el.files && el.files[0], { into: s.id }); return; }
    if (k === 'place-into' && el.value) { edit({ type: 'picture-add', sceneId: s.id, assetId: el.value }); return; }
    if (k === 'place-after' && el.value) { edit({ type: 'picture-scene', sceneId: s.id, assetId: el.value }); return; }
    if (k === 'replace' && el.value) { edit({ type: 'picture-replace', sceneId: s.id, layerId: el.dataset.layer, assetId: el.value }); return; }
    if (k === 'composition' && el.value) { edit({ type: 'composition', sceneId: s.id, composition: el.value }); return; }
    if (k === 'move-words') { edit({ type: 'scene-move', sceneId: s.id, words: el.value }); return; }
    if (k === 'move-picture') { edit({ type: 'scene-move', sceneId: s.id, picture: el.value }); return; }
    if (k === 'signature' && el.value) { edit({ type: 'signature', sceneId: s.id, kind: el.value }); return; }
    if (k === 'model-size') { edit({ type: 'model-resize', modelSceneId: el.dataset.msc, distance: Number(el.value) }); return; }
    if (k === 'model-turn') { edit({ type: 'model-turn', modelSceneId: el.dataset.msc, azimuth: Number(el.value) }); return; }
    if (k === 'model-comp' && el.value) { edit({ type: 'model-composition', modelSceneId: el.dataset.msc, composition: el.value }); return; }
    if (k === 'model-move' && el.value) { edit({ type: 'model-move', modelSceneId: el.dataset.msc, sectionId: el.value }); return; }
  }

  // ---- the Website view asks: which editor does this website get? (render is called from app.js renderWebsite)
  function render(c) {
    var box = qs('#creativeEditor'), biz = qs('#siteEditor'); if (!box) return;
    var creative = !!(c && c.kind === 'creative');
    box.hidden = !creative; if (biz) biz.hidden = creative;
    if (!creative) { if (ED.poll) { clearTimeout(ED.poll); ED.poll = null; } return; }
    if (ED.projectId !== c.projectId) { ED.outline = null; ED.scene = null; ED.pending = null; ED.open = null; ED.drafts = {}; ED.html = {}; say(''); }
    load(false).then(draw);
  }
  var wired = false;
  function wire() { if (wired) return; var box = qs('#creativeEditor'); if (!box) return; wired = true; box.addEventListener('click', onClick); box.addEventListener('change', onChange); box.addEventListener('input', onInput); box.addEventListener('keydown', function (e) { if (e.key === 'Escape' && ED.fontOpen) { var r = ED.fontOpen; ED.fontOpen = null; draw(); var b = qs('#creativeEditor').querySelector('[data-ce="font-open"][data-role="' + r + '"]'); if (b) b.focus(); } }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
  window.CreativeEditor = { render: render, reload: function () { return load(true); }, _state: ED };
})();
