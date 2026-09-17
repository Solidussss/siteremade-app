(()=>{
if(!document.querySelector('link[data-v29-mail]')){const l=document.createElement('link');l.rel='stylesheet';l.href='/v29-mail.css?v=43';l.dataset.v29Mail='1';document.head.appendChild(l)}
if(!document.querySelector('link[data-v34-integrations]')){const l=document.createElement('link');l.rel='stylesheet';l.href='/v34-integrations.css?v=2';l.dataset.v34Integrations='1';document.head.appendChild(l)}
if(!document.querySelector('link[data-v41-experience]')){const l=document.createElement('link');l.rel='stylesheet';l.href='/v41-experience.css?v=1';l.dataset.v41Experience='1';document.head.appendChild(l)}
import('/v29-mail-client.js?v=42').catch(()=>{});
import('/v34-integrations.js?v=2').catch(()=>{});
import('/v35-calendar-client.js?v=1').catch(()=>{});
import('/v36-connectors-client.js?v=1').catch(()=>{});
import('/v38-safe.js?v=7').catch(()=>{});
import('/v39-phone-setup-client.js?v=3').catch(()=>{});
import('/v41-experience.js?v=1').catch(err=>console.error('SiteRemade experience layer:',err));
})();