// SAVED WEBSITES (GET /api/app/websites, routes/website-bridge.js): what the browser receives for each website saved
// to the signed-in person's SiteRemade account. An explicit allowlist of the builder's metadata -- never saved state,
// never pictures -- plus whether THIS workspace is connected to the website (only a connected, owned website can be
// opened here for editing and publishing). No dependencies, so it is tested directly.
'use strict';

function savedWebsiteFrom(w, linkedIds) {
  const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
  const linked = linkedIds instanceof Set ? linkedIds : new Set();
  return {
    projectId: s(w && w.projectId, 120), name: s(w.name, 200), businessName: s(w.businessName, 200),
    mode: w.mode === 'creative' ? 'creative' : 'business',
    status: ['draft', 'checkout_pending', 'purchased'].includes(w.status) ? w.status : 'draft',
    revision: Number.isInteger(w.revision) ? w.revision : null, createdAt: s(w.createdAt, 40), updatedAt: s(w.updatedAt, 40),
    // owned only when the builder says it is purchased AND its status is purchased -- never inferred
    isPurchased: w.isPurchased === true && w.status === 'purchased', purchasedAt: s(w.purchasedAt, 40), hasPurchaseSnapshot: w.hasPurchaseSnapshot === true,
    hasUnpublishedChanges: w.hasUnpublishedChanges === true, linked: linked.has(w.projectId),
  };
}
// most recently updated first
function savedWebsitesFrom(list, linkedIds) {
  return (Array.isArray(list) ? list : []).filter(w => w && typeof w === 'object').map(w => savedWebsiteFrom(w, linkedIds)).filter(w => w.projectId)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

module.exports = { savedWebsiteFrom, savedWebsitesFrom };
