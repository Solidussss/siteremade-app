const fs=require('fs');
const original=fs.readFileSync.bind(fs);
fs.readFileSync=function(file,...args){
  const out=original(file,...args);
  if(typeof out!=='string')return out;
  const name=String(file||'');
  if(!name.endsWith('index.html')&&!name.endsWith('app.html'))return out;
  let html=out;
  if(!html.includes('/v20.css'))html=html.replace('</head>','  <link rel="stylesheet" href="/v20.css?v=20" />\n</head>');

  // Put the Gmail control directly in the Inbox HTML so it is visible even if
  // the mailbox client script fails or an older asset is cached.
  if(!html.includes('data-static-gmail-connect')){
    const inboxNeedle='<section class="view" id="view-inbox">\n        <div class="page-head compact-head"><div><p class="eyebrow">CONVERSATIONS</p><h1>Inbox</h1><p>Website messages and customer conversations in one place.</p></div><button class="primary-action" id="newConversationButton">+ New conversation</button></div>\n        <div class="placeholder-layout">';
    const inboxReplacement='<section class="view" id="view-inbox">\n        <div class="page-head compact-head"><div><p class="eyebrow">CONVERSATIONS</p><h1>Inbox</h1><p>Website messages and customer conversations in one place.</p></div><button class="primary-action" id="newConversationButton">+ New conversation</button></div>\n        <section id="v29MailboxBar" class="v29-mailbar" data-static-gmail-connect>\n          <div><span class="v29-dot"></span><strong>Connect your business inbox</strong><small>Connect Gmail so customer email replies appear here inside SiteRemade.</small></div>\n          <div class="v29-mail-actions"><a class="secondary-button" href="/api/app/gmail/start" data-v29-provider="gmail">Connect Gmail</a></div>\n        </section>\n        <div class="placeholder-layout">';
    html=html.replace(inboxNeedle,inboxReplacement);
  }

  if(!html.includes('/v20-client.js'))html=html.replace('</body>','  <script src="/v20-client.js?v=20"></script>\n  <script src="/v29-bootstrap.js?v=35"></script>\n</body>');
  else html=html.replace('/v29-bootstrap.js?v=29','/v29-bootstrap.js?v=35');
  return html;
};
