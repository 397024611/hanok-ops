(function(root){
'use strict';
function install(o){
 const manager=ReportBossSession.createSessionStore(localStorage,window.AndroidApp);
 let leaving=false,bootPromise=null,noticeTimer=null,notificationBusy=false,routeBusy=false;
 const authorizedStore=()=>{const s=o.state();return !!(s.session&&s.profile?.active===true&&s.profile.user_id===s.session.user.id&&['store','partner'].includes(s.profile.role)&&s.store?.active===true&&s.stores.some(x=>x.id===s.store.id&&x.active===true));};
 const current=epoch=>!leaving&&o.state().epoch===epoch&&!!o.state().session;
 function hydrate(){const s=o.state().session;if(!s)return;try{o.replace(manager.hydrate(s));}catch(error){logout(false);}}
 function sync(){const {session,profile}=o.state();if(!session)return;try{o.replace(manager.sync(session,profile));}catch(error){logout(false);}}
 function login(message=''){
  leaving=true;document.getElementById('app').innerHTML='<div class="login"><div class="loginBox"><h2>Returning to sign in…</h2><p id="loginErr"></p><p id="err"></p></div></div>';
  document.getElementById(o.kind==='hq'?'loginErr':'err').textContent=message;
  if(noticeTimer!==null)return;
  noticeTimer=setTimeout(()=>{try{const text=document.getElementById('loginErr')?.textContent||document.getElementById('err')?.textContent;if(text)sessionStorage.setItem('reportboss_notice',text);}catch{}location.replace('./index.html');},0);
 }
 function logout(...args){const s=o.state().session;manager.clear(s);return o.logout(...args);}
 function retry(error){
  const app=document.getElementById('app');app.replaceChildren();const section=document.createElement('section');section.className='login';
  const box=document.createElement('div');box.className='loginBox';const title=document.createElement('h2');title.textContent='Connection unavailable';
  const message=document.createElement('p');message.textContent='Could not verify your session. Please reconnect and retry.';
  const again=document.createElement('button');again.className='primary';again.textContent='Try again';again.onclick=()=>boot();
  const out=document.createElement('button');out.className='secondary';out.textContent='Sign out';out.onclick=()=>logout();box.append(title,message,again,out);section.append(box);app.append(section);
 }
 async function verify(epoch){
  for(let attempt=0;attempt<2;attempt++){
   const s=o.state().session;if(!current(epoch))return false;
   const r=await fetch(o.url+'/auth/v1/user',{headers:{apikey:o.key,Authorization:'Bearer '+s.access_token},signal:AbortSignal.timeout(25000)});
   if(!current(epoch))return false;
   if(r.status===401&&attempt===0){await o.refresh();continue;}
   if(!r.ok)throw Object.assign(Error('Session verification failed'),{invalidAccount:[400,401,403].includes(r.status)});
   const user=await r.json();if(!current(epoch))return false;
   if(user?.id!==o.state().session.user.id)throw Object.assign(Error('Session identity changed'),{invalidAccount:true});return true;
  }
  return false;
 }
 async function boot(...args){
  if(bootPromise)return bootPromise;
  if(!o.state().session){login();return;}leaving=false;
  const epoch=o.state().epoch;
  const pending=(async()=>{try{hydrate();if(!current(epoch)||!await verify(epoch))return;await o.boot(...args);if(current(epoch)){sync();await afterData();}}catch(error){if(!current(epoch))return;if(error.invalidAccount)logout(false);else retry(error);}})();
  bootPromise=pending;try{return await pending}finally{if(bootPromise===pending)bootPromise=null;}
 }
 async function consumeRoute(){
  if(routeBusy||o.kind!=='store'||!authorizedStore())return;const epoch=o.state().epoch,id=localStorage.getItem('hanokops_pending_ticket');
  if(!id)return;routeBusy=true;
  const same=()=>current(epoch)&&localStorage.getItem('hanokops_pending_ticket')===id;
  try{
   await o.refreshAccess();if(!same())return;
   if(id==='inbox'){localStorage.removeItem('hanokops_pending_ticket');o.close();return;}
   const rows=await o.api('/rest/v1/ops_tickets?id=eq.'+encodeURIComponent(id)+'&select=id,store_id&limit=1');if(!same())return;
   const ticket=rows?.[0],allowed=o.state().stores.some(s=>s.id===ticket?.store_id&&s.active===true);
   if(!ticket||ticket.id!==id||!allowed){localStorage.removeItem('hanokops_pending_ticket');o.toast('This item is no longer available to your account.');return;}
   if(o.state().store?.id!==ticket.store_id){await o.switchStore(ticket.store_id);if(!same())return;}
   if(!o.state().tickets.some(t=>t.id===id&&t.store_id===ticket.store_id))return;
   localStorage.removeItem('hanokops_pending_ticket');o.detail(id);
  }catch(error){/* Keep a permitted unresolved route for the next successful access refresh. */}
  finally{routeBusy=false;}
 }
 async function notifications(){
  if(o.kind!=='store'||notificationBusy||!authorizedStore()||!window.AndroidApp?.notifyAlerts)return;
  notificationBusy=true;const epoch=o.state().epoch;
  try{
   const rows=await o.api('/rest/v1/ops_notifications?recipient_id=eq.'+encodeURIComponent(o.state().session.user.id)+'&select=id,ticket_id,title,body,priority,read_at,created_at&read_at=is.null&order=created_at.desc&limit=100');
   if(!current(epoch))return;hydrate();if(!current(epoch))return;
   // The existing recipient + current-ticket-access RLS filters these rows. This adds no recipients or notification generator.
   window.AndroidApp.notifyAlerts(JSON.stringify(rows||[]),o.state().session.refresh_token);
  }catch(error){/* Optional notifications must not block the operating workspace. */}finally{notificationBusy=false;}
 }
 async function afterData(){
  if(o.kind!=='store'||!authorizedStore())return;
  sync();if(!authorizedStore())return;await consumeRoute();if(!authorizedStore())return;
  const text=localStorage.getItem('hanokops_pending_share');if(text&&o.state().session&&o.share(text)!==false&&localStorage.getItem('hanokops_pending_share')===text)localStorage.removeItem('hanokops_pending_share');
  await notifications();
 }
 window.addEventListener('pagehide',()=>{leaving=true;bootPromise=null;o.suspend?.();document.getElementById('app').replaceChildren();});
 window.addEventListener('pageshow',event=>{if(event.persisted&&o.state().session){const saved=manager.saved();if(!saved||saved.user.id!==o.state().session.user.id){logout(false);return;}o.replace(saved);document.getElementById('app').replaceChildren();boot();}});
 window.addEventListener('storage',event=>{
  if(!Object.values(ReportBossSession.KEYS).includes(event.key)||event.newValue!==null||!o.state().session)return;
  // A removal event may arrive after another page has already inserted its replacement.
  // Re-read current ownership instead of deleting that replacement during legacy teardown.
  let live=null;try{live=JSON.parse(localStorage.getItem(ReportBossSession.KEYS[o.kind])||'null');}catch{}
  if(live?.user?.id===o.state().session.user.id&&live.access_token&&live.refresh_token)return;
  logout(false);
 });
 return {boot,logout,login,sync,hydrate,afterData};
}
root.ReportBossWorkspace={install};
})(globalThis);
