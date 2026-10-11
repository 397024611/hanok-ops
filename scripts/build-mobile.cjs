'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),out=path.join(root,'mobile-dist');
fs.mkdirSync(out,{recursive:true});
for(const name of ['index.html','entry.css','entry.js','access.js','session.js','workspace.js'])fs.copyFileSync(path.join(root,'mobile',name),path.join(out,name));
for(const name of ['glass.css','assets'])if(fs.existsSync(path.join(root,'mobile',name)))fs.cpSync(path.join(root,'mobile',name),path.join(out,name),{recursive:true});
const hq=fs.readFileSync(path.join(root,'android/app/src/main/assets/index.html'),'utf8');
const store=fs.readFileSync(path.join(root,'store-portal/index.html'),'utf8');
const url=JSON.parse(hq.match(/const SB_URL=("[^"]+")/)[1]);
const key=JSON.parse(hq.match(/const SB_KEY=("[^"]+")/)[1]);
const stores=JSON.parse(store.match(/const STORES=(\[[^\n]+\]);/)[1].replace(/([{,])(code|name):/g,'$1"$2":'));
if(!key.startsWith('sb_publishable_'))throw Error('Only a publishable API key may be bundled.');
fs.writeFileSync(path.join(out,'config.js'),'window.ReportBossConfig='+JSON.stringify({url,key,stores})+';\n');
let entry=fs.readFileSync(path.join(out,'index.html'),'utf8');
if(!entry.includes('src="session.js"'))entry=entry.replace('<script src="entry.js">','<script src="session.js"></script><script src="entry.js">');
fs.writeFileSync(path.join(out,'index.html'),entry);
function replaceOnce(source,needle,replacement){if(source.split(needle).length!==2)throw Error('Workspace integration marker missing or duplicated: '+needle);return source.replace(needle,replacement);}
function workspace(source,kind){
 const hqMode=kind==='hq',end=hqMode?'if(session)boot();else showLogin();':'if(session)boot();else loginPage();';
 source=replaceOnce(source,'<script>','<script src="session.js"></script><script src="workspace.js"></script><script>');
 const state=hqMode?'({session,profile,epoch:sessionEpoch})':'({session,profile,epoch:authEpoch,stores:assignedStores,store,tickets})';
 const key=hqMode?'hanokops_session':'hanok_store_session';
 if(hqMode)source=source.replace('Store accounts use the separate Store Report Portal. This app is for HQ and administrators.','Use Staff Login for staff accounts, or Boss Login for partner accounts.');
 if(hqMode)source=replaceOnce(source,'  localStorage.removeItem("hanokops_session");localStorage.removeItem("hanokops_pending_ticket");','  // Persistent logout cleanup is owned by the scoped mobile session manager.');
 if(hqMode){
  const start=source.indexOf('async function refreshSession(){'),end=source.indexOf('async function signIn(){',start);
  if(start<0||end<0)throw Error('HQ refresh integration marker missing');
  let refresh=source.slice(start,end);
  refresh=replaceOnce(refresh,'  refreshPromise=(async()=>{','  const pending=(async()=>{');
  refresh=replaceOnce(refresh,'  try{return await refreshPromise}finally{refreshPromise=null}','  refreshPromise=pending;\n  try{return await pending}finally{if(refreshPromise===pending)refreshPromise=null}');
  source=source.slice(0,start)+refresh+source.slice(end);
  const bootStart=source.indexOf('async function boot(restoreNative=true){'),bootEnd=source.indexOf('async function loadTickets(',bootStart);
  if(bootStart<0||bootEnd<0)throw Error('HQ boot integration marker missing');
  let boot=source.slice(bootStart,bootEnd);
  boot=replaceOnce(boot,'async function boot(restoreNative=true){','async function boot(restoreNative=true){\n  const bootEpoch=sessionEpoch;');
  boot=replaceOnce(boot,'    profile=ps&&ps[0];','    if(bootEpoch!==sessionEpoch)return;\n    profile=ps&&ps[0];');
  boot=replaceOnce(boot,'    stores=await api(','    const bootStores=await api(');
  boot=replaceOnce(boot,'||[];loadLocalProjects();loadPendingTicketDraft();','||[];if(bootEpoch!==sessionEpoch)return;stores=bootStores;loadLocalProjects();loadPendingTicketDraft();');
  boot=replaceOnce(boot,'    people=await api(','    const bootPeople=await api(');
  boot=replaceOnce(boot,'&order=display_name.asc\")||[];','&order=display_name.asc\")||[];if(bootEpoch!==sessionEpoch)return;people=bootPeople;');
  boot=replaceOnce(boot,'    await Promise.all([loadTickets(true,true),loadNotifications(true)]);','    if(bootEpoch!==sessionEpoch)return;\n    await Promise.all([loadTickets(true,true),loadNotifications(true)]);if(bootEpoch!==sessionEpoch)return;');
  boot=replaceOnce(boot,'}catch(e){if(session){','}catch(e){if(bootEpoch!==sessionEpoch)return;if(session){');
  boot=replaceOnce(boot,'finally{showLoading(false)}','finally{if(bootEpoch===sessionEpoch)showLoading(false)}');
  source=source.slice(0,bootStart)+boot+source.slice(bootEnd);
  source=replaceOnce(source,'}catch(e){if(session)lastSyncError=e.message}finally{refreshRunning=false}','}catch(e){if(epoch===sessionEpoch&&session)lastSyncError=e.message}finally{if(epoch===sessionEpoch)refreshRunning=false}');
  // Preserve existing account-help requests, but prevent a dismissed help screen from publishing late state.
  const helpMethods=[['signIn','forgotPassword'],['forgotPassword','verifyRecoveryLink'],['verifyRecoveryLink','showNewPasswordForm'],['setRecoveredPassword','signUp'],['signUp','logout']];
  for(const [name,next] of helpMethods){
   const from=source.indexOf('async function '+name+'(){'),until=source.indexOf('function '+next+'(',from);
   if(from<0||until<0)throw Error('Account-help integration marker missing: '+name);
   let method=source.slice(from,until);
   method=replaceOnce(method,'async function '+name+'(){','async function '+name+'(){\n  const accountHelpEpoch=sessionEpoch;');
   if(name==='signIn'||name==='signUp')method=replaceOnce(method,'const j=await r.json();','const j=await r.json();if(accountHelpEpoch!==sessionEpoch)return;');
   if(name==='forgotPassword'||name==='setRecoveredPassword')method=replaceOnce(method,'    if(!r.ok)throw','    if(accountHelpEpoch!==sessionEpoch)return;\n    if(!r.ok)throw');
   if(name==='verifyRecoveryLink')method=replaceOnce(method,'    recoveryAccessToken=accessToken;','    if(accountHelpEpoch!==sessionEpoch)return;\n    recoveryAccessToken=accessToken;');
   method=method.replace(/catch\(e\)\{/g,'catch(e){if(accountHelpEpoch!==sessionEpoch)return;').replace(/finally\{showLoading\(false\)\}/g,'finally{if(accountHelpEpoch===sessionEpoch)showLoading(false)}');
   source=source.slice(0,from)+method+source.slice(until);
  }
 }
 else source=replaceOnce(source,'window.addEventListener("storage",e=>{if(e.key===SESSION_KEY&&e.newValue===null&&session)logout(false)});','// Cross-document storage changes are handled by the scoped mobile session manager.');
 const extra=hqMode?`,accountHelp:showLogin,clearHelp:()=>{sessionEpoch++;recoveryAccessToken='';document.querySelectorAll('input').forEach(input=>input.value='');},suspend:()=>{sessionEpoch++;recoveryAccessToken='';refreshPromise=null;refreshRunning=false;clearInterval(refreshTimer);refreshTimer=null;closeDetail();}`:`,suspend:()=>{authEpoch++;refreshPromise=null;accessPromise=null;authController.abort();authController=new AbortController();clearInterval(timer);timer=null;clearStoreContext();},refreshAccess:()=>refreshAccess(),api:(...args)=>api(...args),switchStore:id=>switchStore(id),detail:id=>detail(id),close:()=>closeOverlay(),toast:text=>toast(text),share:text=>{if(profile?.role==='store'){if(draft?.payload||draft?.busy){toast('Finish your current submission before adding shared text.');return false;}newTicket();const input=document.getElementById('desc');if(!input)return false;input.value=(input.value?input.value+String.fromCharCode(10):'')+text;input.dispatchEvent(new Event('input',{bubbles:true}));}else toast('Quick Capture is available to staff and HQ accounts.');return true;}`;
 const hooks=`
// Generated native workspace integration. The standalone web portal keeps its original URL and login flow.
const mobileWorkspace=ReportBossWorkspace.install({kind:'${kind}',url:SB_URL,key:SB_KEY,state:()=>${state},replace:next=>{session=next;if(next)localStorage.setItem('${key}',JSON.stringify(next));},boot:boot,logout:logout,refresh:()=>${hqMode?'refreshSession()':'refresh()'}${extra}});
boot=mobileWorkspace.boot;logout=mobileWorkspace.logout;
${hqMode?`showLogin=mobileWorkspace.login;syncNativeSession=mobileWorkspace.sync;hydrateNativeSession=mobileWorkspace.hydrate;clearNativeSession=()=>{};`:`loginPage=mobileWorkspace.login;
const mobilePersist=persistSession;persistSession=()=>{if(session)mobilePersist();mobileWorkspace.sync();};
const mobileRefresh=refresh;refresh=async()=>{mobileWorkspace.hydrate();return mobileRefresh();};
const mobileAccess=refreshAccess;refreshAccess=async()=>{const result=await mobileAccess();mobileWorkspace.sync();return result;};
const mobileLoad=loadTickets;loadTickets=async(...args)=>{await mobileLoad(...args);await mobileWorkspace.afterData();};
window.hydrateNativeSession=mobileWorkspace.hydrate;window.refreshAll=()=>loadTickets(true);
window.receiveNotificationTicket=id=>{if(typeof id==='string'&&id){localStorage.setItem('hanokops_pending_ticket',id);mobileWorkspace.afterData();}};
window.receiveNotificationInbox=()=>{localStorage.setItem('hanokops_pending_ticket','inbox');mobileWorkspace.afterData();};
window.receiveSharedText=text=>{if(typeof text==='string'&&text){localStorage.setItem('hanokops_pending_share',text);mobileWorkspace.afterData();}};
window.handleAndroidBack=()=>{if(view){closeOverlay();return true;}return false;};`}
${hqMode?'if(session)boot();else if(!mobileWorkspace.initialAccountHelp())showLogin();':end}`;
 return replaceOnce(source,end,hooks);
}
fs.writeFileSync(path.join(out,'hq.html'),workspace(hq,'hq'));
fs.writeFileSync(path.join(out,'store.html'),workspace(store,'store'));
console.log('Built unified mobile-dist assets: index.html selector, hq.html and store.html. Native host must use this generated directory.');
