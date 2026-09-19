const fs=require('fs');
const prevRead=fs.readFileSync.bind(fs);
fs.readFileSync=function(file,...args){
  const out=prevRead(file,...args);
  if(typeof out!=='string')return out;
  const name=String(file||'');
  if(!name.endsWith('index.html'))return out;
  if(out.includes('id="view-integrations"'))return out;
  let html=out;
  const nav='<button class="nav-item" data-view="integrations"><span>⌘</span><strong>Integrations</strong><em id="integrationBadge" hidden>0</em></button>';
  html=html.replace('<button class="nav-item" data-view="settings"><span>⚙</span><strong>Settings</strong></button>',nav+'\n        <button class="nav-item" data-view="settings"><span>⚙</span><strong>Settings</strong></button>');
  const view='\n      <section class="view" id="view-integrations"><div class="page-head compact-head"><div><p class="eyebrow">CONNECTED APPS</p><h1>Integrations</h1><p>Connect the tools your business already uses and run them from SiteRemade.</p></div><span class="coming-badge" id="integrationSummary">0 connected</span></div><div class="v34-feature"><strong>One customer system.</strong><p>Email, calls, bookings, payments, ads, accounting and documents all stay connected to the same lead.</p></div><div id="v34Grid" class="v34-grid"></div></section>\n';
  html=html.replace('</main>',view+'</main>');
  return html;
};
