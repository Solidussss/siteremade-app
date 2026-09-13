const fs=require('fs');
const original=fs.readFileSync.bind(fs);
fs.readFileSync=function(file,...args){const out=original(file,...args);if(typeof out!=='string')return out;const name=String(file||'');if(!name.endsWith('index.html')&&!name.endsWith('app.html'))return out;let html=out;if(!html.includes('/v20.css'))html=html.replace('</head>','  <link rel="stylesheet" href="/v20.css?v=20" />\n</head>');if(!html.includes('/v20-client.js'))html=html.replace('</body>','  <script src="/v20-client.js?v=20"></script>\n  <script src="/v29-bootstrap.js?v=29"></script>\n</body>');return html;};
