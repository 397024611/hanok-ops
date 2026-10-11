(function(root){
'use strict';
// UI routing only. Live backend policies remain the authorization boundary.
const destinations=Object.freeze({hq:'./hq.html',store:'./store.html'});
function routeFor(entry,userId,profile,stores=[]){
 if(!['boss','staff'].includes(entry))throw Error('Choose Boss Login or Staff Login.');
 if(!userId||!profile||profile.user_id!==userId||profile.active!==true)throw Error('This account is inactive or unavailable. Contact your administrator.');
 const role=profile.role;
 if(entry==='boss'&&['admin','hq'].includes(role))return {workspace:'hq',url:destinations.hq,sessionKey:'hanokops_session'};
 if(entry==='staff'&&role!=='store')throw Error('Use Boss Login for this account.');
 if(entry==='boss'&&role==='store')throw Error('Use Staff Login for this account.');
 if(!['store','partner'].includes(role))throw Error('Your account needs administrator setup.');
 const allowed=stores.filter(s=>s&&s.active===true&&typeof s.id==='string'&&(role!=='store'||s.id===profile.store_id));
 if(!allowed.length)throw Error('No active stores are assigned to this account.');
 return {workspace:'store',url:destinations.store,sessionKey:'hanok_store_session',storeIds:[...new Set(allowed.map(s=>s.id))]};
}
function createGate(adapter){
 let epoch=0,busy=false,controller=null;
 function cancel(){epoch++;busy=false;controller?.abort();controller=null;}
 async function run(entry,load,restoring=false){
  if(busy)return null;
  busy=true;const mine=++epoch;controller=new AbortController();const signal=controller.signal;
  const current=()=>{if(mine!==epoch||signal.aborted)throw Object.assign(Error('Cancelled'),{name:'AbortError'});};
  try{
   let session=await load(signal);current();
   if(!session?.access_token||!session?.refresh_token||!session?.user?.id)throw Error('Invalid sign-in response.');
   let user;
   try{user=await adapter.verifyUser(session,signal)}catch(error){
    if(!restoring||![400,401].includes(error.status)||!adapter.refreshSession)throw error;
    const previousId=session.user.id;session=await adapter.refreshSession(session,signal);current();
    if(session?.user?.id!==previousId)throw Object.assign(Error('Session identity changed'),{invalidAccount:true});
    if(!session?.user?.id||!session.access_token||!session.refresh_token)throw Error('Invalid renewed session.');
    user=await adapter.verifyUser(session,signal);
   }current();
   if(user?.id!==session.user.id)throw Error('Could not verify this account.');
   const profile=await adapter.profile(session,signal);current();
   const stores=['store','partner'].includes(profile?.role)?await adapter.stores(session,signal):[];current();
   const chosen=restoring?(profile?.role==='store'?'staff':'boss'):entry;
   const route=routeFor(chosen,user.id,profile,stores);
   // No passwords or role selections are persisted. Never put tokens in URLs.
   adapter.commit(session,route,profile,{restoring});return route;
  }catch(error){current();throw error;}finally{if(mine===epoch){busy=false;controller=null;}}
 }
 return {signIn:(entry,credentials)=>run(entry,signal=>adapter.authenticate(credentials,signal)),restore:session=>run(null,async()=>session,true),cancel,get busy(){return busy;}};
}
const api={routeFor,createGate};if(typeof module==='object'&&module.exports)module.exports=api;else root.ReportBossAccess=api;
})(typeof globalThis==='object'?globalThis:this);
