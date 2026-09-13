const fs=require('fs');
const original=fs.readFileSync.bind(fs);
fs.readFileSync=function(file,...args){const out=original(file,...args);if(typeof out!=='string')return out;const name=String(file||'');if(!name.endsWith('index.html')&&!name.endsWith('app.html'))return out;let html=out;if(!html.includes('/v22.css?v=23'))html=html.replace('</head>','  <link rel="stylesheet" href="/v22.css?v=23" />\n</head>');if(!html.includes('/v22-client.js?v=23'))html=html.replace('</body>','  <script src="/v22-client.js?v=23"></script>\n</body>');return html;};
