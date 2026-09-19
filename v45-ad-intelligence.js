// Backend routes formerly defined here (ad-control/settings,
// ad-recommendations/*) have been migrated to routes/ad-intelligence.js —
// see lib/router.js and PHASE3-ROUTE-MAP.md. This file now only owns the
// fs.readFileSync patch that injects the client-side ad-intelligence
// script tag into index.html; that's frontend-consolidation work for a
// later phase, not a route.
require('dotenv').config();
const fs=require('fs');
const prevRead=fs.readFileSync.bind(fs);

fs.readFileSync=function(file,...args){
  const out=prevRead(file,...args);
  if(typeof out!=='string')return out;
  const name=String(file||'');
  if(!name.endsWith('index.html'))return out;
  if(out.includes('v45-ad-intelligence-client.js'))return out;
  return out.replace('</body>','<script src="/v45-ad-intelligence-client.js"></script>\n</body>');
};
