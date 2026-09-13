require('dotenv').config();
const http=require('http');
const previous=http.createServer.bind(http);
const send=(res,status,obj)=>{const body=JSON.stringify(obj);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Length':Buffer.byteLength(body)});res.end(body)};
const has=(...names)=>names.every(n=>!!process.env[n]);
http.createServer=function(listener){return previous(async(req,res)=>{try{const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);if(req.method==='GET'&&u.pathname==='/api/app/integrations/status'){const providers={
gmail:{configured:has('GOOGLE_GMAIL_CLIENT_ID','GOOGLE_GMAIL_CLIENT_SECRET')||has('GOOGLE_OAUTH_CLIENT_ID','GOOGLE_OAUTH_CLIENT_SECRET')},
google_calendar:{configured:has('GOOGLE_OAUTH_CLIENT_ID','GOOGLE_OAUTH_CLIENT_SECRET')||has('GOOGLE_GMAIL_CLIENT_ID','GOOGLE_GMAIL_CLIENT_SECRET')},
twilio:{configured:has('TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN')},
stripe:{configured:!!(process.env.STRIPE_SECRET_KEY||process.env.STRIPE_API_KEY)},
google_analytics:{configured:!!(process.env.GOOGLE_ANALYTICS_PROPERTY_ID&&process.env.GOOGLE_SERVICE_ACCOUNT_JSON)},
google_business:{configured:has('GOOGLE_OAUTH_CLIENT_ID','GOOGLE_OAUTH_CLIENT_SECRET')||has('GOOGLE_GMAIL_CLIENT_ID','GOOGLE_GMAIL_CLIENT_SECRET')},
google_ads:{configured:!!(process.env.GOOGLE_ADS_DEVELOPER_TOKEN&&process.env.GOOGLE_ADS_CLIENT_ID&&process.env.GOOGLE_ADS_CLIENT_SECRET)},
meta_ads:{configured:!!(process.env.META_APP_ID&&process.env.META_APP_SECRET)},
quickbooks:{configured:!!(process.env.QUICKBOOKS_CLIENT_ID&&process.env.QUICKBOOKS_CLIENT_SECRET)},
xero:{configured:!!(process.env.XERO_CLIENT_ID&&process.env.XERO_CLIENT_SECRET)},
slack:{configured:!!(process.env.SLACK_CLIENT_ID&&process.env.SLACK_CLIENT_SECRET)},
teams:{configured:!!(process.env.MICROSOFT_OAUTH_CLIENT_ID&&process.env.MICROSOFT_OAUTH_CLIENT_SECRET)},
zapier:{configured:true,label:'Webhook framework ready'},
docusign:{configured:!!(process.env.DOCUSIGN_INTEGRATION_KEY&&process.env.DOCUSIGN_SECRET_KEY)},
pandadoc:{configured:!!process.env.PANDADOC_API_KEY}
};return send(res,200,{ok:true,providers})}return listener(req,res)}catch(e){if(!res.headersSent)return send(res,500,{ok:false,message:e.message||'Integration status error'});res.end()}})};