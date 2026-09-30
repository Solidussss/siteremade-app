// SAVED WEBSITES -- every website saved to the customer's SiteRemade account, drafts and purchased, as the Website
// view lists it (data: GET /api/app/websites). Plain functions that turn that list into HTML, loaded by index.html
// before app.js (window.SavedWebsitesView) and by the tests (module.exports), so what a Draft row and an Owned row
// show -- and never show -- is pinned in one place.
//
// A saved draft and a purchased website are different things, and the rows say so:
//   Draft    name, "Draft", Business/Creative, last updated, a preview of the saved draft, "Continue in the builder".
//            No download, no hosting, no "owned" wording -- a draft's files are only handed over with a purchase.
//   Owned    name, "Owned", Business/Creative, last updated, purchase date, the website files (.zip), a preview,
//            hosting & handoff, and opening it here (a website connected to this business) or connecting it.
(function (root) {
  'use strict';
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const STATUS = {
    draft: { label: 'Draft', tone: 'neutral' },
    checkout_pending: { label: 'Checkout in progress', tone: 'warning' },
    purchased: { label: 'Owned', tone: 'success' },
  };
  const MODE = { business: 'Business website', creative: 'Creative page' };
  const BUILDER = '/handoff/website-builder';
  function dateLabel(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function sortWebsites(list) { return (Array.isArray(list) ? list : []).slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))); }
  function nameOf(w) { return w.businessName || w.name || 'Untitled website'; }
  const enc = id => encodeURIComponent(id);

  // opts: { currentProjectId, busyProjectId }
  function rowHtml(w, opts) {
    const o = opts || {};
    const owned = w.isPurchased === true && w.status === 'purchased';
    const status = owned ? STATUS.purchased : (STATUS[w.status] && w.status !== 'purchased' ? STATUS[w.status] : STATUS.draft);
    const meta = [MODE[w.mode] || MODE.business, w.updatedAt ? `Updated ${dateLabel(w.updatedAt)}` : '', owned && w.purchasedAt ? `Purchased ${dateLabel(w.purchasedAt)}` : ''].filter(Boolean);
    const current = o.currentProjectId && o.currentProjectId === w.projectId;
    let actions, note;
    if (owned) {
      const open = current ? '<span class="saved-website-current">Showing above</span>'
        : w.linked ? `<button type="button" class="secondary-button" data-saved-open="${esc(w.projectId)}">Open here</button>`
          : `<button type="button" class="secondary-button" data-saved-connect="${esc(w.projectId)}"${o.busyProjectId === w.projectId ? ' disabled' : ''}>${o.busyProjectId === w.projectId ? 'Connecting…' : 'Connect to this business'}</button>`;
      actions = [
        open,
        `<a class="saved-website-link" data-saved-download href="/api/app/websites/${enc(w.projectId)}/download">Download website files (.zip)</a>`,
        `<a class="saved-website-link" target="_blank" rel="noopener" href="/api/app/websites/${enc(w.projectId)}/preview?source=published">Preview ↗</a>`,
        `<a class="saved-website-link" href="${BUILDER}">Hosting &amp; handoff in the builder ↗</a>`,
      ];
      note = w.hasUnpublishedChanges ? 'Yours to keep and host anywhere. It has saved changes that aren’t published yet.' : 'Yours to keep and host anywhere.';
    } else {
      actions = [
        `<a class="saved-website-link" target="_blank" rel="noopener" href="/api/app/websites/${enc(w.projectId)}/preview">Preview draft ↗</a>`,
        `<a class="saved-website-link" href="${BUILDER}">Continue in the builder ↗</a>`,
      ];
      note = w.status === 'checkout_pending' ? 'Saved to your account. Checkout for it is in progress.' : 'Saved to your account, not purchased yet. Buy it in the builder to get its files and host it.';
    }
    return `<li class="saved-website" data-saved-website="${esc(w.projectId)}" data-state="${owned ? 'owned' : 'draft'}">
      <div class="saved-website-main"><strong class="saved-website-name">${esc(nameOf(w))}</strong><span class="chip chip-${status.tone}">${esc(status.label)}</span></div>
      <p class="saved-website-meta">${meta.map(esc).join(' · ')}</p>
      <p class="saved-website-note">${esc(note)}</p>
      <div class="saved-website-actions">${actions.join('')}</div>
    </li>`;
  }
  // state: { status: 'idle'|'loading'|'ready'|'unavailable', list, message, error }
  function listHtml(state, opts) {
    const s = state || {};
    const head = '<p class="eyebrow">SAVED WEBSITES</p><h3>Your saved websites</h3>';
    if (s.status === 'loading' || s.status === 'idle') return `${head}<p class="saved-websites-empty">Loading your saved websites…</p>`;
    if (s.status !== 'ready') return `${head}<p class="saved-websites-empty">${esc(s.message || 'Your saved websites couldn’t be loaded right now.')}</p>`;
    const list = sortWebsites(s.list);
    if (!list.length) return `${head}<p class="saved-websites-empty">Nothing saved yet. Websites you generate and save in the SiteRemade builder appear here — drafts too.</p><a class="saved-website-link" href="${BUILDER}">Open the SiteRemade builder ↗</a>`;
    const owned = list.filter(w => w.isPurchased === true && w.status === 'purchased').length;
    const summary = `${list.length} saved · ${owned} owned · ${list.length - owned} draft${list.length - owned === 1 ? '' : 's'}`;
    const error = s.error ? `<p class="saved-websites-empty" role="status">${esc(s.error)}</p>` : '';
    return `${head}<p class="saved-websites-summary">${esc(summary)}</p>${error}<ul class="saved-websites-list">${list.map(w => rowHtml(w, opts)).join('')}</ul>`;
  }

  const api = { rowHtml, listHtml, sortWebsites, STATUS, dateLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SavedWebsitesView = api;
})(typeof window !== 'undefined' ? window : this);
