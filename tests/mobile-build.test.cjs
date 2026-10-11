const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{spawnSync}=require('node:child_process'),vm=require('node:vm');
const {JSDOM,VirtualConsole}=require('jsdom');
const build=spawnSync(process.execPath,['scripts/build-mobile.cjs'],{encoding:'utf8'});assert.equal(build.status,0,build.stderr);
test('mobile build integrates native role workspaces while preserving raw sources, package and origin',()=>{
 for(const [kind,source] of [['hq','android/app/src/main/assets/index.html'],['store','store-portal/index.html']]){
  const raw=fs.readFileSync(source,'utf8'),generated=fs.readFileSync('mobile-dist/'+kind+'.html','utf8');
  assert.ok(!raw.includes('const mobileWorkspace='));assert.match(generated,/ReportBossWorkspace.install/);assert.match(generated,/src="session.js"/);
  for(const match of generated.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi))new vm.Script(match[1]);
 }
 assert.match(fs.readFileSync('android/app/build.gradle','utf8'),/applicationId 'com.hanokgroup.ops'/);
 assert.match(fs.readFileSync('android/app/src/main/java/com/hanokgroup/ops/MainActivity.java','utf8'),/LOCAL_HOST = "hanokops.local"/);
 assert.match(fs.readFileSync('mobile-dist/index.html','utf8'),/src="session.js"/);
});
function fixture(kind,role,options={}){
 const html=fs.readFileSync('mobile-dist/'+kind+'.html','utf8'),vc=new VirtualConsole();vc.on('jsdomError',e=>{if(!e.message.includes('navigation'))throw e;});
 const dom=new JSDOM(html,{url:'https://hanokops.local/'+kind+'.html'+(options.hash||''),runScripts:'outside-only',virtualConsole:vc}),w=dom.window;
 w.AbortController=AbortController;w.AbortSignal=AbortSignal;w.URL.createObjectURL=()=>'';w.URL.revokeObjectURL=()=>{};
 const s={user:{id:'u'},access_token:'fake-access',refresh_token:'fake-refresh'},state={role,active:true,authId:'u',calls:[],native:JSON.stringify({access_token:'fake-access',refresh_token:'fake-refresh'}),clears:0};
 if(!options.noSession)w.localStorage.setItem(kind==='hq'?'hanokops_session':'hanok_store_session',JSON.stringify(s));
 else state.native='null';
 w.AndroidApp={getStoredSession:()=>state.native,updateRoleSession:(a,r,role,expected)=>{state.native=JSON.stringify({access_token:a,refresh_token:r,role});return true},saveRoleSession:(a,r,role)=>{state.native=JSON.stringify({access_token:a,refresh_token:r,role});return true},clearSessionIfCurrent:expected=>{if(JSON.parse(state.native||'null')?.refresh_token!==expected)return false;state.clears++;state.native='null';return true},notifyAlerts(){},getVersionName:()=> '0.9.2'};
 if(options.native===false)delete w.AndroidApp;
 w.fetch=async(url,opts={})=>{
  state.calls.push(url);let body=[];
  if(url.endsWith('/auth/v1/user'))body={id:state.authId};
  else if(url.includes('/auth/v1/logout'))return new Response(null,{status:204});
  else if(url.includes('/ops_profiles?'))body=url.includes('user_id=eq.')?[{user_id:'u',role:state.role,active:state.active,store_id:'s',display_name:'Fictional Person',email:'test@example.invalid'}]:[];
  else if(url.includes('/ops_stores?'))body=[{id:'s',active:true,name:'Fictional store',code:'ONE'}];
  else if(url.includes('api.github.com/'))return new Response('{}',{status:404});
  else if(!url.includes('/rest/v1/'))throw Error('Unexpected URL '+url);
  return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
 };
 w.eval(fs.readFileSync('mobile/session.js','utf8'));w.eval(fs.readFileSync('mobile/workspace.js','utf8').replace("location.replace('./index.html')","window.__redirect='./index.html'"));
 for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi))if(match[1].trim())w.eval(match[1]);
 return {dom,w,state};
}
const settle=async()=>{for(let i=0;i<25;i++)await new Promise(r=>setTimeout(r,5));};
for(const [kind,role] of [['hq','hq'],['store','store'],['store','partner']])test('generated '+role+' verifies identity, scopes workspace and logs out to selector',async()=>{
 const {dom,w,state}=fixture(kind,role);await settle();assert.ok(state.calls.some(u=>u.endsWith('/auth/v1/user')));assert.equal(w.__redirect,undefined);
 assert.equal(JSON.parse(state.native).role,role);if(kind==='store')assert.ok(state.calls.some(u=>u.includes('ops_notifications?recipient_id=eq.u')));
 w.logout();await settle();assert.equal(w.__redirect,'./index.html');assert.equal(w.localStorage.getItem('hanokops_session'),null);assert.equal(w.localStorage.getItem('hanok_store_session'),null);assert.ok(state.clears>=1);dom.window.close();
});
test('generated HQ refuses a valid staff identity before rendering HQ data',async()=>{
 const {dom,w,state}=fixture('hq','store');await settle();assert.equal(w.__redirect,'./index.html');assert.ok(!state.calls.some(u=>u.includes('/ops_tickets?')));dom.window.close();
});
test('generated store refuses inactive identity and never requests tickets',async()=>{
 const {dom,w,state}=fixture('store','store');state.active=false;await settle();assert.equal(w.__redirect,'./index.html');assert.ok(!state.calls.some(u=>u.includes('/ops_tickets?')));dom.window.close();
});
test('native shared text updates the staff draft model and survives close/reopen',async()=>{
 const {dom,w}=fixture('store','store');await settle();w.receiveSharedText('Fictional broken fridge');await settle();
 assert.equal(w.document.getElementById('desc').value,'Fictional broken fridge');
 w.receiveSharedText('Fictional follow-up');await settle();assert.equal(w.document.getElementById('desc').value,'Fictional broken fridge\nFictional follow-up');
 w.closeOverlay();w.newTicket();assert.equal(w.document.getElementById('desc').value,'Fictional broken fridge\nFictional follow-up');
 assert.equal(w.localStorage.getItem('hanokops_pending_share'),null);dom.window.close();
});
test('native ticket intent never opens a ticket hidden by server access',async()=>{
 const {dom,w,state}=fixture('store','partner');await settle();w.receiveNotificationTicket('forbidden-ticket');await settle();
 assert.equal(w.document.querySelector('#overlay.show'),null);assert.equal(w.localStorage.getItem('hanokops_pending_ticket'),null);
 assert.ok(state.calls.some(u=>u.includes('ops_tickets?id=eq.forbidden-ticket')));dom.window.close();
});
test('restoring a cached signed-out workspace does not resurrect its valid old token',async()=>{
 const {dom,w,state}=fixture('hq','hq');await settle();w.dispatchEvent(new w.PageTransitionEvent('pagehide'));
 assert.equal(w.document.getElementById('app').textContent,'');
 w.localStorage.removeItem('hanokops_session');state.native='null';
 const before=state.calls.length;w.dispatchEvent(new w.PageTransitionEvent('pageshow',{persisted:true}));await settle();
 assert.equal(w.__redirect,'./index.html');assert.ok(!state.calls.slice(before).some(u=>u.includes('/ops_tickets?')));dom.window.close();
});
for(const [kind,role] of [['hq','hq'],['store','store']])for(const native of [true,false])test('stale '+kind+' logout preserves replacement owner with native='+native,async()=>{
 const {dom,w,state}=fixture(kind,role,{native});await settle();
 const key=kind==='hq'?'hanokops_session':'hanok_store_session',old=w.localStorage.getItem(key);
 const next={user:{id:'replacement-user'},access_token:'replacement-access',refresh_token:'replacement-refresh'};
 w.localStorage.setItem(key,JSON.stringify(next));w.localStorage.setItem('reportboss_workspace',kind);
 w.localStorage.setItem('hanokops_pending_ticket','replacement-ticket');w.localStorage.setItem('hanokops_pending_share','replacement-share');
 state.native=JSON.stringify({...next,role});
 w.dispatchEvent(new w.StorageEvent('storage',{key,oldValue:old,newValue:null}));await settle();
 assert.equal(w.__redirect,'./index.html');assert.deepEqual(JSON.parse(w.localStorage.getItem(key)),next);
 assert.equal(w.localStorage.getItem('reportboss_workspace'),kind);assert.equal(w.localStorage.getItem('hanokops_pending_ticket'),'replacement-ticket');assert.equal(w.localStorage.getItem('hanokops_pending_share'),'replacement-share');
 assert.equal(JSON.parse(state.native).refresh_token,'replacement-refresh');dom.window.close();
});
for(const [kind,role] of [['hq','hq'],['store','store']])test('obsolete '+kind+' deletion event is ignored when current owner still has a live session',async()=>{
 const {dom,w}=fixture(kind,role);await settle();const key=kind==='hq'?'hanokops_session':'hanok_store_session';
 const before=w.localStorage.getItem(key);w.dispatchEvent(new w.StorageEvent('storage',{key,newValue:null,oldValue:before}));await settle();
 assert.equal(w.__redirect,undefined);assert.equal(w.localStorage.getItem(key),before);dom.window.close();
});
test('HQ resume starts a fresh refresh and old completion cannot clear its single-flight handle',async()=>{
 const {dom,w}=fixture('hq','hq');await settle();const fetch=w.fetch;let tokens=0,first,second;
 w.fetch=async(url,opts={})=>{
  if(url.includes('/token?grant_type=refresh_token')){tokens++;return new Promise(resolve=>{if(tokens===1)first=resolve;else if(tokens===2)second=resolve;else throw Error('Duplicate new refresh');});}
  if(url.endsWith('/auth/v1/user')&&opts.headers.Authorization==='Bearer fake-access')return new Response('{}',{status:401});
  return fetch(url,opts);
 };
 const obsolete=w.refreshSession();await settle();assert.equal(tokens,1);
 w.dispatchEvent(new w.PageTransitionEvent('pagehide'));w.dispatchEvent(new w.PageTransitionEvent('pageshow',{persisted:true}));await settle();assert.equal(tokens,2);
 first(new Response(JSON.stringify({user:{id:'u'},access_token:'obsolete-access',refresh_token:'obsolete-refresh'}),{status:200}));await obsolete;
 const shared=w.refreshSession();await settle();assert.equal(tokens,2);
 second(new Response(JSON.stringify({user:{id:'u'},access_token:'fresh-access',refresh_token:'fresh-refresh'}),{status:200}));await shared;await settle();
 assert.equal(w.__redirect,undefined);assert.equal(JSON.parse(w.localStorage.getItem('hanokops_session')).access_token,'fresh-access');dom.window.close();
});
test('Store resume does not reuse the pre-suspend membership single-flight promise',async()=>{
 const {dom,w}=fixture('store','store');await settle();const fetch=w.fetch;let reads=0,finish;
 w.fetch=async(url,opts={})=>{if(url.includes('/ops_profiles?')&&url.includes('user_id=eq.')){reads++;if(reads===1)return new Promise(resolve=>finish=resolve);}return fetch(url,opts);};
 const obsolete=w.refreshAccess().catch(()=>{});await settle();assert.equal(reads,1);
 w.dispatchEvent(new w.PageTransitionEvent('pagehide'));w.dispatchEvent(new w.PageTransitionEvent('pageshow',{persisted:true}));await settle();assert.ok(reads>=2);
 finish(new Response(JSON.stringify([{user_id:'u',role:'store',active:true,store_id:'s'}]),{status:200}));await obsolete;await settle();
 assert.equal(w.__redirect,undefined);assert.ok(w.document.getElementById('app').textContent.includes('Fictional store'));assert.ok(w.localStorage.getItem('hanok_store_session'));dom.window.close();
});
test('obsolete HQ boot cannot replace a successfully resumed workspace with its error screen',async()=>{
 const {dom,w}=fixture('hq','hq');await settle();const fetch=w.fetch;let profiles=0,finish;
 w.fetch=async(url,opts={})=>{if(url.includes('/ops_profiles?user_id=eq.')){profiles++;if(profiles===1)return new Promise(resolve=>finish=resolve);}return fetch(url,opts);};
 const obsolete=w.boot(false);await settle();assert.equal(profiles,1);
 w.dispatchEvent(new w.PageTransitionEvent('pagehide'));w.dispatchEvent(new w.PageTransitionEvent('pageshow',{persisted:true}));await settle();assert.ok(profiles>=2);
 const before=w.document.getElementById('app').textContent;assert.ok(before.includes('Fictional Person'));
 finish(new Response(JSON.stringify([{user_id:'u',role:'hq',active:true,display_name:'Obsolete Person',email:'old@example.invalid'}]),{status:200}));await obsolete;await settle();
 assert.equal(w.document.getElementById('app').textContent,before);assert.equal(w.__redirect,undefined);assert.ok(w.localStorage.getItem('hanokops_session'));dom.window.close();
});
test('explicit signed-out account-help route preserves legacy recovery/signup controls and Back',async()=>{
 const {dom,w,state}=fixture('hq','hq',{hash:'#account-help',noSession:true});await settle();
 const text=w.document.getElementById('app').textContent;assert.match(text,/Forgot password/);assert.match(text,/Create account/);assert.ok(w.document.getElementById('recoveryLink'));assert.ok(w.document.getElementById('accountHelpBack'));
 assert.equal(state.calls.length,0);assert.equal(w.__redirect,undefined);
 w.document.getElementById('accountHelpBack').click();await settle();assert.equal(w.__redirect,'./index.html');assert.equal(w.localStorage.getItem('hanokops_session'),null);dom.window.close();
});
test('account help reuses recovery endpoints and returns safely to selector after password update',async()=>{
 const {dom,w,state}=fixture('hq','hq',{hash:'#account-help',noSession:true});await settle();const requests=[];
 w.fetch=async(url,opts)=>{requests.push({url,method:opts.method,body:JSON.parse(opts.body)});if(url.endsWith('/auth/v1/verify'))return new Response(JSON.stringify({access_token:'fictional-recovery-token'}),{status:200});return new Response('{}',{status:200});};
 w.document.getElementById('email').value='fictional@example.invalid';await w.forgotPassword();assert.ok(!w.document.getElementById('recoveryTools').classList.contains('hidden'));
 w.document.getElementById('recoveryLink').value='https://example.invalid/reset?token_hash=fictional-hash';await w.verifyRecoveryLink();
 assert.ok(w.document.getElementById('newPassword'));w.document.getElementById('newPassword').value='fictional-password-only';w.document.getElementById('confirmPassword').value='fictional-password-only';await w.setRecoveredPassword();await settle();
 assert.deepEqual(requests.map(r=>new URL(r.url).pathname),['/auth/v1/recover','/auth/v1/verify','/auth/v1/user']);
 assert.equal(requests[1].body.type,'recovery');assert.equal(requests[2].method,'PUT');assert.equal(w.__redirect,'./index.html');assert.equal(w.localStorage.length,0);dom.window.close();
});
test('account help keeps original signup payload with no role or membership grant',async()=>{
 const {dom,w}=fixture('hq','hq',{hash:'#account-help',noSession:true});await settle();let payload,url;
 w.fetch=async(u,opts)=>{url=u;payload=JSON.parse(opts.body);return new Response(JSON.stringify({user:{id:'pending-user'}}),{status:200});};
 w.document.getElementById('email').value='new@example.invalid';w.document.getElementById('password').value='fictional-password-only';await w.signUp();
 assert.ok(url.endsWith('/auth/v1/signup'));assert.deepEqual(payload,{email:'new@example.invalid',password:'fictional-password-only',data:{display_name:'new'}});assert.equal(w.localStorage.getItem('hanokops_session'),null);dom.window.close();
});
test('leaving account help cancels late recovery completion without restoring password UI',async()=>{
 const {dom,w}=fixture('hq','hq',{hash:'#account-help',noSession:true});await settle();let finish;
 w.fetch=()=>new Promise(resolve=>finish=resolve);w.document.getElementById('recoveryLink').value='https://example.invalid/reset?token_hash=fictional-hash';const pending=w.verifyRecoveryLink();
 w.document.getElementById('accountHelpBack').click();await settle();finish(new Response(JSON.stringify({access_token:'fictional-recovery-token'}),{status:200}));await pending;
 assert.equal(w.__redirect,'./index.html');assert.equal(w.document.getElementById('newPassword'),null);assert.equal(w.localStorage.getItem('hanokops_session'),null);dom.window.close();
});
test('existing active workspace does not bypass verification through account-help fragment',async()=>{
 const {dom,w,state}=fixture('hq','store',{hash:'#account-help'});await settle();assert.equal(w.document.getElementById('accountHelpBack'),null);assert.equal(w.__redirect,'./index.html');assert.ok(!state.calls.some(u=>u.includes('/ops_tickets?')));dom.window.close();
});
