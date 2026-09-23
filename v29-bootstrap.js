(()=>{
// Website-first shell (Phase 3I): this hub used to also load the
// Integrations screen and everything that decorated it. Disconnected here
// (files kept on disk, just not loaded):
//   v34-integrations.js + v34-integrations.css — the Integrations screen
//     (15 provider cards, 6 of them with no backend at all). Replaced by
//     Settings → Connections in app.js, which only lists providers with a
//     real backend.
//   v35-calendar-client.js, v36-connectors-client.js — Google Calendar /
//     Twilio / Stripe buttons that only existed on those v34 cards.
//   v38-safe.js — read connection state back out of the v34 cards' DOM, so
//     without them it would report Stripe/Calendar as "not connected".
//   v39-phone-setup-client.js — second Business SMS bar inside the old
//     Inbox; the connection now lives in Settings → Connections.
// Still loaded for compatibility with the staff-only internal screens and
// Admin: v29-mail-client (legacy Inbox Gmail layer), v41/v42 (legacy lead
// drawer / calendar / overview workflow panels), v43/v44/v46 (Admin ad
// control room, Google Ads account + campaigns). v45 is loaded by app.js.
if(!document.querySelector('link[data-v29-mail]')){const l=document.createElement('link');l.rel='stylesheet';l.href='/v29-mail.css?v=43';l.dataset.v29Mail='1';document.head.appendChild(l)}
if(!document.querySelector('link[data-v41-experience]')){const l=document.createElement('link');l.rel='stylesheet';l.href='/v41-experience.css?v=1';l.dataset.v41Experience='1';document.head.appendChild(l)}
if(!document.querySelector('link[data-v42-daily]')){const l=document.createElement('link');l.rel='stylesheet';l.href='/v42-daily-workflow.css?v=1';l.dataset.v42Daily='1';document.head.appendChild(l)}
if(!document.querySelector('link[data-v43-ads]')){const l=document.createElement('link');l.rel='stylesheet';l.href='/v43-ad-control.css?v=1';l.dataset.v43Ads='1';document.head.appendChild(l)}
import('/v29-mail-client.js?v=42').catch(()=>{});
import('/v41-experience.js?v=2').catch(err=>console.error('SiteRemade experience layer:',err));
import('/v42-daily-workflow.js?v=1').catch(err=>console.error('SiteRemade daily workflow layer:',err));
import('/v43-ad-control.js?v=1').catch(err=>console.error('SiteRemade ad control layer:',err));
import('/v44-google-ads-client.js?v=2').catch(err=>console.error('SiteRemade Google Ads layer:',err));
// v45-ad-intelligence-client.js is already loaded via its own <script> tag
// (see app.js's loadDashboardFeatureScripts()) — this used to import() it a
// SECOND time under a different URL (?v=2 vs no query), so the browser
// fetched and executed the whole file twice on every dashboard load: two
// submit listeners double-firing every ad-settings save, and worse, two
// permanent MutationObservers each watching the entire document for every
// DOM change for the rest of the page's life. Removed (production-
// readiness/performance review) — nothing here needs a second copy.
import('/v46-google-ads-account-fallback.js?v=2').catch(err=>console.error('SiteRemade Google Ads account fallback:',err));
})();
