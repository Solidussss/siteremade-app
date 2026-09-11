require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SECRET_KEY||(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
if(!url||!key) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) first.');
const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
const email=process.env.OWNER_EMAIL||'admin@siteremade.com';
const password=process.env.OWNER_PASSWORD;
if(!password||password==='change-this-before-running') throw new Error('Set a strong OWNER_PASSWORD first.');
const name=process.env.OWNER_NAME||'SiteRemade Owner';
const workspaceName=process.env.OWNER_WORKSPACE||'SiteRemade Demo';
(async()=>{
  let user;
  const list=await db.auth.admin.listUsers({page:1,perPage:1000});
  user=list.data?.users?.find(u=>u.email?.toLowerCase()===email.toLowerCase());
  if(!user){const made=await db.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{name}});if(made.error)throw made.error;user=made.data.user;}
  let q=await db.from('profiles').upsert({id:user.id,name,role:'owner'});if(q.error)throw q.error;
  let existing=await db.from('workspace_members').select('workspace_id').eq('user_id',user.id).limit(1);
  let wid=existing.data?.[0]?.workspace_id;
  if(!wid){const created=await db.from('workspaces').insert({business_name:workspaceName,email}).select('*').single();if(created.error)throw created.error;wid=created.data.id;
    q=await db.from('workspace_members').insert({workspace_id:wid,user_id:user.id,role:'owner'});if(q.error)throw q.error;
    const autos=[['lead-confirmation','Instant lead confirmation','When a new lead arrives → create/send a confirmation.'],['lead-alert','New lead alert','When a lead arrives → notify the business immediately.'],['appointment-reminder','Appointment reminder','24 hours before appointment → create a reminder.']].map(([automation_key,name,description])=>({workspace_id:wid,automation_key,name,description,enabled:true}));
    q=await db.from('automations').insert(autos);if(q.error)throw q.error;
  }
  console.log('SiteRemade owner ready:',email,'workspace:',wid);
})().catch(e=>{console.error(e);process.exit(1)});
