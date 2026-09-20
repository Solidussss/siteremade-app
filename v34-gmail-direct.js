// Backend route formerly defined here (GET /api/app/gmail/start) has been
// migrated to routes/gmail-direct.js — see lib/router.js and
// PHASE3-ROUTE-MAP.md. This file now only owns the fs.readFileSync patch
// that injects a click-interception script into index.html; that's
// frontend-consolidation work for a later phase, not a route.
require('dotenv').config();
const fs=require('fs');
const prevRead=fs.readFileSync.bind(fs);

fs.readFileSync=function(file,...args){const out=prevRead(file,...args);if(typeof out!=='string')return out;const name=String(file||'');if(!name.endsWith('index.html'))return out;if(out.includes('data-gmail-direct-v34'))return out;const script=`<script data-gmail-direct-v34>document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-v29-provider="gmail"]');if(!b)return;e.preventDefault();e.stopImmediatePropagation();window.location.assign('/api/app/gmail/start');},true);</script>`;return out.replace('</body>',script+'\n</body>')};
