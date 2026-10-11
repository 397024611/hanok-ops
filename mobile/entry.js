'use strict';
const $=id=>document.getElementById(id),config=window.ReportBossConfig;
let entry=null,method='individual';
const sessionStore=window.ReportBossSession?.createSessionStore(localStorage,window.AndroidApp);
let restoreStarted=false;const entryIntent={};
async function request(path,session,signal,body){
 const r=await fetch(config.url+path,{method:body?'POST':'GET',headers:{apikey:config.key,...(session?{Authorization:'Bearer '+session.access_token}:{}),...(body?{'Content-Type':'application/json'}:{})},signal:AbortSignal.any([signal,AbortSignal.timeout(30000)]),...(body?{body:JSON.stringify(body)}:{})});
 if(!r.ok)throw Object.assign(Error([400,401].includes(r.status)?'Check your sign-in details and try again.':'Sign in is unavailable. Please try again.'),{status:r.status});
 return r.json();
}
const gate=ReportBossAccess.createGate({
 authenticate:(credentials,signal)=>request('/auth/v1/token?grant_type=password',null,signal,credentials),
 refreshSession:(s,signal)=>request('/auth/v1/token?grant_type=refresh_token',null,signal,{refresh_token:s.refresh_token}),
 verifyUser:(s,signal)=>request('/auth/v1/user',s,signal),
 profile:async(s,signal)=>(await request('/rest/v1/ops_profiles?user_id=eq.'+encodeURIComponent(s.user.id)+'&select=user_id,role,store_id,active',s,signal))[0],
 stores:(s,signal)=>request('/rest/v1/ops_stores?active=eq.true&select=id,active&order=name.asc',s,signal),
 commit(s,route,profile,options){
  if(sessionStore)sessionStore.commit(s,route,profile,options);
  else{localStorage.removeItem('hanokops_session');localStorage.removeItem('hanok_store_session');localStorage.setItem(route.sessionKey,JSON.stringify(s));}
  for(const [key,value] of Object.entries(entryIntent))localStorage.setItem(key,value);
  window.location.replace(route.url);
 }
});
function setMethod(next){
 gate.cancel();method=next;$('form').reset();$('error').textContent='';$('submit').disabled=false;
 const shared=method==='shared';$('email-wrap').hidden=shared;$('email').required=!shared;$('store-wrap').hidden=!shared;
 document.querySelectorAll('[data-method]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.method===method)));
}
function showEntry(next){
 const status=document.getElementById('restoreStatus');if(status)status.remove();
 gate.cancel();entry=['boss','staff'].includes(next)?next:null;$('form').reset();$('error').textContent='';$('submit').disabled=false;
 $('choose').hidden=!!entry;$('login').hidden=!entry;if(!entry)return;
 $('login-title').textContent=entry==='boss'?'老板登录 / Boss Login':'员工登录 / Staff Login';
 $('login-description').textContent=entry==='boss'?'HQ and partners: use your individual account.':'Use your individual staff account or the existing shared store login.';
 $('methods').hidden=entry!=='staff';setMethod('individual');$('login-title').focus();
}
document.querySelectorAll('[data-entry]').forEach(b=>b.addEventListener('click',()=>{history.pushState(null,'','#'+b.dataset.entry);showEntry(b.dataset.entry);}));
document.querySelectorAll('[data-method]').forEach(b=>b.addEventListener('click',()=>setMethod(b.dataset.method)));
$('back').addEventListener('click',()=>{history.replaceState(null,'',location.pathname);showEntry(null);document.querySelector('[data-entry]').focus();});
window.addEventListener('popstate',()=>showEntry(location.hash.slice(1)));
window.addEventListener('pagehide',()=>{gate.cancel();$('form').reset();});
window.addEventListener('pageshow',event=>{if(event.persisted){restoreStarted=false;showEntry(location.hash.slice(1));restoreSaved();}});
for(const store of config.stores){const option=document.createElement('option');option.value=store.code;option.textContent=store.name;$('store').append(option);}
$('form').addEventListener('submit',async e=>{
 e.preventDefault();if(gate.busy)return;$('error').textContent='';$('submit').disabled=true;
 const credentials={email:method==='shared'?'store.'+$('store').value.toLowerCase()+'@hanokops.invalid':$('email').value.trim(),password:$('password').value};
 $('password').value='';
 try{await gate.signIn(entry,credentials)}catch(error){if(error.name!=='AbortError')$('error').textContent=error.message}
 finally{credentials.password='';if(!gate.busy)$('submit').disabled=false;}
});
showEntry(location.hash.slice(1));

function restoreStatus(message,retry=false){
 let panel=document.getElementById('restoreStatus');if(!panel){panel=document.createElement('div');panel.id='restoreStatus';panel.setAttribute('role','status');$('choose').append(panel);}
 panel.replaceChildren();const text=document.createElement('p');text.textContent=message;panel.append(text);
 if(retry){const button=document.createElement('button');button.className='text-button';button.textContent='Retry / 重试';button.onclick=()=>{restoreStarted=false;restoreSaved();};panel.append(button);const out=document.createElement('button');out.className='text-button';out.textContent='Sign out / 退出';out.onclick=()=>{gate.cancel();sessionStore?.clear(sessionStore.saved());showEntry(null);};panel.append(out);}
}
async function restoreSaved(){
 if(restoreStarted||entry||!sessionStore)return;restoreStarted=true;const saved=sessionStore.saved();if(!saved)return;
 restoreStatus('Restoring your session / 正在恢复登录…');
 try{await gate.restore(sessionStore.hydrate(saved));}
 catch(error){if(error.name==='AbortError')return;if(error.invalidAccount||[400,401,403].includes(error.status)||/inactive|No active stores|administrator setup|verify this account/.test(error.message)){sessionStore.clear(saved);restoreStatus('Please sign in again / 请重新登录');}else restoreStatus('Could not reconnect. Your saved session is kept. / 暂时无法连接，登录记录已保留。',true);}
}
window.receiveNotificationTicket=id=>{if(typeof id==='string'&&id){entryIntent.hanokops_pending_ticket=id;localStorage.setItem('hanokops_pending_ticket',id);}};
window.receiveNotificationInbox=()=>{entryIntent.hanokops_pending_ticket='inbox';localStorage.setItem('hanokops_pending_ticket','inbox');};
window.receiveSharedText=text=>{if(typeof text==='string'&&text){entryIntent.hanokops_pending_share=text;localStorage.setItem('hanokops_pending_share',text);}};
window.hydrateNativeSession=()=>{};
window.refreshAll=()=>{if(!gate.busy&&!entry){restoreStarted=false;restoreSaved();}};
restoreSaved();

try{const notice=sessionStorage.getItem('reportboss_notice');sessionStorage.removeItem('reportboss_notice');if(notice&&!entry&&!sessionStore?.saved())restoreStatus(notice);}catch{}
