// WHICH WEBSITE THE WEBSITE VIEW OPENS -- after a reload, a closed tab or a brand-new device. Plain functions, loaded by
// index.html before app.js (window.WebsiteSelection) and by the tests (module.exports), so the rule is pinned in one place.
// From this business's connected websites (GET /api/app/website/projects):
//   1. a website connected AFTER the person last chose one here (a new purchase) -- the newest of those;
//   2. otherwise the website the person last opened here, if it can still be opened;
//   3. otherwise the most recently updated one (then the most recently connected);
//   4. otherwise nothing -- the view keeps the builder's own answer (its newest purchase) or the delivery record.
// Only a purchased website the builder answered for is ever picked: never a draft, never one that is unavailable right
// now, never one no longer connected here -- so an old failed draft can't hide, replace or become the default for a
// website bought later. The remembered choice is a per-browser convenience only (localStorage, per workspace) -- never
// authorization: every request for it still goes through the workspace's link and the builder's ownership check.
(function (root) {
  'use strict';
  const PROJECT_ID_RE = /^proj_[A-Za-z0-9_-]{8,64}$/;
  const usable = p => !!(p && typeof p.projectId === 'string' && PROJECT_ID_RE.test(p.projectId) && !p.unavailable && p.status === 'purchased');
  const newest = (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || String(b.linkedAt || '').localeCompare(String(a.linkedAt || ''));
  // remembered: { id, at } (what remembered() returns) or null
  function chooseWebsiteProject(projects, remembered) {
    const list = (Array.isArray(projects) ? projects : []).filter(usable);
    const r = remembered && typeof remembered === 'object' ? remembered : null;
    if (r && r.at) {
      const since = list.filter(p => p.projectId !== r.id && p.linkedAt && String(p.linkedAt) > String(r.at)).sort(newest);
      if (since.length) return since[0].projectId;
    }
    if (r && list.some(p => p.projectId === r.id)) return r.id;
    const best = list.slice().sort(newest)[0];
    return best ? best.projectId : null;
  }
  const keyFor = wid => 'sr_website_selected:' + String(wid || '');
  function remembered(storage, wid) {
    try {
      const raw = storage && wid ? storage.getItem(keyFor(wid)) : null; if (!raw) return null;
      const v = JSON.parse(raw);
      return v && PROJECT_ID_RE.test(String(v.id || '')) ? { id: v.id, at: typeof v.at === 'string' ? v.at.slice(0, 40) : null } : null;
    } catch (e) { return null; }
  }
  function remember(storage, wid, projectId, now) {
    try {
      if (!storage || !wid) return;
      if (projectId && PROJECT_ID_RE.test(projectId)) storage.setItem(keyFor(wid), JSON.stringify({ id: projectId, at: now || new Date().toISOString() }));
      else storage.removeItem(keyFor(wid));
    } catch (e) { /* private window / blocked storage: the view still works, it just doesn't remember */ }
  }
  const api = { chooseWebsiteProject, remembered, remember, keyFor, usable };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WebsiteSelection = api;
})(typeof window !== 'undefined' ? window : this);
