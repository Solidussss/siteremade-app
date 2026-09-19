// Backend routes formerly defined here (the "port your existing business
// number" hosted-SMS wizard) have been migrated to
// routes/twilio-existing-number.js — see lib/router.js and
// PHASE3-ROUTE-MAP.md. This file now only owns the fs.readFileSync patch
// that injects the wizard's client-side script tag into index.html;
// that's frontend-consolidation work for a later phase, not a route.
require('dotenv').config();
const fs=require('fs');
const previousRead=fs.readFileSync.bind(fs);

fs.readFileSync=function(file,...args){const out=previousRead(file,...args);if(typeof out!=='string')return out;const name=String(file||'');if(!name.endsWith('index.html'))return out;if(out.includes('v40-existing-number-client.js?v=3'))return out;const cleaned=out.replace(/<script src="\/v40-existing-number-client\.js\?v=\d+"><\/script>/g,'');return cleaned.replace('</body>','<script src="/v40-existing-number-client.js?v=3"></script></body>')};
