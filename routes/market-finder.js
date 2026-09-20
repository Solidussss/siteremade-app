// Migrated from v19-market-server.js (deleted). Logic is unchanged — only
// the http.createServer wrapper + manual path/method check were replaced
// by router.post() + { auth: 'user' }.
const { db } = require('../lib/context');

const clean = (v, n = 500) => String(v ?? '').trim().slice(0, n);
const readBody = req => new Promise((resolve, reject) => { let s = ''; req.on('data', c => { s += c; if (s.length > 200000) { reject(Error('Request too large')); req.destroy(); } }); req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(Error('Invalid JSON')); } }); req.on('error', reject); });
function fit(place, purpose) { let s = 20; if (place.nationalPhoneNumber) s += 20; if (place.websiteUri) s += purpose === 'partners' ? 12 : 4; else if (purpose !== 'partners') s += 18; const r = Number(place.rating || 0), reviews = Number(place.userRatingCount || 0); if (r >= 4.5) s += 18; else if (r >= 4) s += 12; else if (r >= 3.5) s += 5; if (reviews >= 10) s += 8; if (reviews >= 25) s += 6; if (reviews <= 250) s += 6; if (reviews > 1000) s -= 8; return Math.max(0, Math.min(100, s)); }
async function googlePage(query, pageToken = '') { const body = { textQuery: query, pageSize: 20 }; if (pageToken) body.pageToken = pageToken; const r = await fetch('https://places.googleapis.com/v1/places:searchText', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.googleMapsUri,nextPageToken' }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw Error(j.error?.message || 'Google Places search failed.'); return j; }

module.exports = function registerMarketFinderRoutes(router) {
  router.post('/api/v19/prospects/search', { auth: 'user' }, async (req, res, { c: ctx, json }) => {
    if (!process.env.GOOGLE_PLACES_API_KEY) return json(res, 200, { ok: true, live: false, prospects: [] });
    const b = await readBody(req), type = clean(b.businessType, 120), location = clean(b.location, 160);
    if (!type || !location) return json(res, 400, { ok: false, message: 'Business type and location are required.' });
    const purpose = ['prospects', 'commercial', 'partners', 'competitors'].includes(clean(b.purpose, 30)) ? clean(b.purpose, 30) : 'prospects', query = `${type} in ${location}`;
    let all = [], token = '';
    for (let i = 0; i < 3; i++) { const page = await googlePage(query, token); all.push(...(page.places || [])); token = page.nextPageToken || ''; if (!token) break; }
    const viewedRows = (await db.from('prospect_views').select('place_id').eq('workspace_id', ctx.wid).limit(5000)).data || [], viewed = new Set(viewedRows.map(x => x.place_id));
    const minRating = Number(b.minRating || 0), maxRating = Number(b.maxRating || 0), minReviews = Number(b.minReviews || 0), maxReviews = Number(b.maxReviews || 0), website = clean(b.website, 20) || 'any', phone = clean(b.phone, 20) || 'any', newOnly = String(b.newOnly) === 'true';
    let rows = all.map(p => ({ placeId: p.id, name: p.displayName?.text || 'Business', address: p.formattedAddress || '', phone: p.nationalPhoneNumber || '', website: p.websiteUri || '', rating: Number(p.rating) || 0, reviews: Number(p.userRatingCount) || 0, mapsUrl: p.googleMapsUri || '', purpose, viewed: viewed.has(p.id), fitScore: fit(p, purpose) }));
    rows = rows.filter(p => (!minRating || p.rating >= minRating) && (!maxRating || p.rating <= maxRating) && (!minReviews || p.reviews >= minReviews) && (!maxReviews || p.reviews <= maxReviews) && (website !== 'yes' || !!p.website) && (website !== 'no' || !p.website) && (phone !== 'yes' || !!p.phone) && (!newOnly || !p.viewed));
    const sort = clean(b.sort, 30);
    if (sort === 'rating_desc') rows.sort((a, z) => z.rating - a.rating);
    else if (sort === 'rating_asc') rows.sort((a, z) => a.rating - z.rating);
    else if (sort === 'reviews_desc') rows.sort((a, z) => z.reviews - a.reviews);
    else if (sort === 'reviews_asc') rows.sort((a, z) => a.reviews - z.reviews);
    else rows.sort((a, z) => z.fitScore - a.fitScore);
    return json(res, 200, { ok: true, live: true, purpose, prospects: rows.slice(0, 60) });
  });
};
