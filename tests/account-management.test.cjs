const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM,VirtualConsole}=require('jsdom');
const ADMIN='10000000-0000-4000-8000-000000000001', STAFF='10000000-0000-4000-8000-000000000002', PARTNER='10000000-0000-4000-8000-000000000003';
const A='20000000-0000-4000-8000-000000000001',B='20000000-0000-4000-8000-000000000002';
const session={user:{id:ADMIN},access_token:'mock-admin-access',refresh_token:'mock-refresh'};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test){for(let n=0;n<200;n++){if(test())return;await wait(5)}throw Error('UI did not become ready')}
async function fixture(options={}){
 const state={role:'admin',active:true,delay:0,failCreate:false,rejectPassword:false,pendingRequests:[],passwordUnchanged:false,createdInactive:false,requests:[],...options};
 state.accounts=[{user_id:ADMIN,email:'owner@example.invalid',display_name:'Owner',role:'admin',active:true,store_ids:[]},{user_id:STAFF,email:'staff@example.invalid',display_name:'Store Staff',role:'store',active:true,store_ids:[A]},{user_id:PARTNER,email:'partner@example.invalid',display_name:'Partner',role:'partner',active:true,store_ids:[A,B]}];
 state.stores=[{id:A,code:'HWD',name:'Hanok Woden',active:true},{id:B,code:'HWG',name:'Hanok Wagga',active:true}];
 const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM(fs.readFileSync('android/app/src/main/assets/index.html','utf8'),{url:'https://hanokops.local',runScripts:'dangerously',virtualConsole:vc,beforeParse(w){
  w.localStorage.setItem('hanokops_session',JSON.stringify(session));w.URL.createObjectURL=()=> 'blob:mock';w.URL.revokeObjectURL=()=>{};
  w.fetch=async(url,opts={})=>{
   let body=[],status=200;
   if(url.includes('/ops-admin-accounts')){
    const data=JSON.parse(opts.body);state.requests.push(data);await wait(state.delay);
    if(data.action==='list')body={accounts:state.accounts,stores:state.stores,pending_requests:state.pendingRequests};
    if(data.action==='create_store'){
     if(state.storeError)return new Response(JSON.stringify({error:state.storeError}),{status:409,headers:{'Content-Type':'application/json'}});
     let store=state.stores.find(s=>s.requestId===data.requestId);
     if(!store){store={id:'20000000-0000-4000-8000-000000000099',name:data.name,code:data.code,active:true,requestId:data.requestId};state.stores.push(store)}
     if(state.lostStore){state.lostStore=false;throw Error('Mock lost response')}
     body={ok:true,store,request_id:data.requestId};
    }
    if(data.action==='create'){
     if(state.failCreate){state.failCreate=false;throw Error('Mock lost response')}
     if(state.rejectPassword){state.rejectPassword=false;return new Response(JSON.stringify({error:'password_rejected'}),{status:400,headers:{'Content-Type':'application/json'}})}
     let account=state.accounts.find(a=>a.requestId===data.requestId);
     if(!account){account={user_id:'10000000-0000-4000-8000-000000000099',email:data.email,display_name:data.displayName,role:data.role,active:!state.createdInactive,store_ids:data.storeIds,requestId:data.requestId};state.accounts.push(account)}
     body={ok:true,account,password_unchanged:state.passwordUnchanged};
    }
    if(data.action==='assign'){const account=state.accounts.find(a=>a.user_id===data.userId);account.store_ids=data.storeIds;body={ok:true,account}}
    if(data.action==='deactivate'){const account=state.accounts.find(a=>a.user_id===data.userId);account.active=false;body={ok:true,account}}
   }else if(url.includes('/ops_profiles'))body=[{user_id:ADMIN,email:'owner@example.invalid',display_name:'Owner',role:state.role,active:state.active,store_id:null}];
   else if(url.includes('/ops_stores')){await wait(state.storeDelay||0);body=state.stores}
   else if(url.includes('api.github.com/')){status=404;body={}}
   else if(url.includes('/auth/v1/token'))body=session;
   return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
  }
 }});
 const w=dom.window;await until(()=>w.document.querySelector('#homeCapture')||w.document.querySelector('#loginErr')?.textContent);return {w,state,errors,close:()=>w.close(),value:(id,value)=>w.document.getElementById(id).value=value};
}
async function createForm(f,role='store'){
 await f.w.openAccounts();f.w.startNewAccount();f.value('accountName','New Person');f.value('accountEmail','NEW@example.invalid');f.value('accountPassword','Mock-test-password-123');f.value('accountRole',role);f.w.changeAccountRole();f.w.document.querySelector('input[name="accountStores"]').checked=true;
}
test('only active admin sees management and direct HQ calls cannot list or create',async()=>{
 for(const role of ['admin','hq']){const f=await fixture({role});try{f.w.go('profile');assert.equal(!!f.w.document.querySelector('#accountManagementButton'),role==='admin');await f.w.openAccounts();assert.equal(f.state.requests.length,role==='admin'?1:0);assert.equal(f.errors.length,0)}finally{f.close()}}
});
test('staff create normalizes email, uses one store, suppresses repeat clicks and never persists password',async()=>{
 const f=await fixture({delay:20});try{await createForm(f);await Promise.all([f.w.createManagedAccount(),f.w.createManagedAccount()]);const req=f.state.requests.filter(r=>r.action==='create');assert.equal(req.length,1);assert.equal(req[0].email,'new@example.invalid');assert.equal(req[0].role,'store');assert.deepEqual(req[0].storeIds,[A]);assert.ok(req[0].requestId);assert.equal(f.w.eval('accountManagement.payload'),null);assert.equal(f.w.document.querySelector('#accountPassword'),null);assert.ok(!Object.keys(f.w.localStorage).some(k=>(f.w.localStorage.getItem(k)||'').includes('Mock-test-password-123')));assert.match(f.w.document.querySelector('#app').textContent,/New Person/)}finally{f.close()}
});
test('partner creation permits multiple assigned stores but never HQ/admin role creation',async()=>{
 const f=await fixture();try{await createForm(f,'partner');for(const e of f.w.document.querySelectorAll('[name="accountStores"]'))e.checked=true;await f.w.createManagedAccount();assert.deepEqual(f.state.requests.find(r=>r.action==='create').storeIds,[A,B]);f.w.startNewAccount();assert.deepEqual([...f.w.document.querySelector('#accountRole').options].map(o=>o.value),['store','partner']);f.value('accountName','Injected Role');f.value('accountEmail','x@example.invalid');f.value('accountPassword','Mock-test-password-123');f.w.document.querySelector('#accountRole').innerHTML='<option value="admin">Admin</option>';f.w.document.querySelector('[name="accountStores"]').checked=true;await f.w.createManagedAccount();assert.equal(f.state.requests.filter(r=>r.action==='create').length,1);assert.match(f.w.document.querySelector('#accountActionStatus').textContent,/staff or partner/)}finally{f.close()}
});
test('create validates fields before requests',async()=>{
 const f=await fixture();try{await createForm(f);f.value('accountPassword','short');await f.w.createManagedAccount();assert.match(f.w.document.querySelector('#accountActionStatus').textContent,/at least 12/);f.value('accountPassword','Mock-test-password-123');f.w.document.querySelector('[name="accountStores"]').checked=false;await f.w.createManagedAccount();assert.match(f.w.document.querySelector('#accountActionStatus').textContent,/exactly one/);assert.equal(f.state.requests.filter(r=>r.action==='create').length,0)}finally{f.close()}
});
test('unconfirmed create keeps one request ID and frozen details for safe retry',async()=>{
 const f=await fixture({failCreate:true});try{await createForm(f);await f.w.createManagedAccount();assert.equal(f.w.document.querySelector('#accountName').disabled,true);assert.equal(f.w.document.querySelector('#accountPassword').disabled,true);assert.equal(f.w.document.querySelector('#accountSubmit').disabled,false);assert.match(f.w.document.querySelector('#accountActionStatus').textContent,/not confirmed/);await f.w.createManagedAccount();const requests=f.state.requests.filter(r=>r.action==='create');assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);assert.equal(f.state.accounts.filter(a=>a.email==='new@example.invalid').length,1)}finally{f.close()}
});
test('cancel and Android Back clear unfinished password payload and return without mutation',async()=>{
 const f=await fixture({failCreate:true});try{await createForm(f);await f.w.createManagedAccount();assert.ok(f.w.eval('accountManagement.payload'));f.w.handleAndroidBack();await until(()=>!f.w.eval('accountManagement.busy'));assert.equal(f.w.eval('accountManagement.payload'),null);assert.equal(f.w.document.querySelector('#accountPassword'),null);assert.equal(f.w.eval('accountManagement.view'),'list');f.w.handleAndroidBack();assert.equal(f.w.eval('page'),'profile')}finally{f.close()}
});
test('store assignment and confirmed deactivation send only intended target',async()=>{
 const f=await fixture();try{await f.w.openAccounts();f.w.editAccountStores(2);f.w.document.querySelectorAll('[name="accountStores"]')[0].checked=false;await f.w.saveAccountStores();const req=f.state.requests.find(r=>r.action==='assign');assert.equal(req.userId,PARTNER);assert.deepEqual(req.storeIds,[B]);f.w.confirmDeactivateAccount(1);assert.equal(f.state.requests.filter(r=>r.action==='deactivate').length,0);assert.match(f.w.document.querySelector('#app').textContent,/already signed in/);await f.w.deactivateManagedAccount();assert.equal(f.state.requests.find(r=>r.action==='deactivate').userId,STAFF);assert.equal(f.state.accounts[1].active,false);f.w.editAccountStores(1);assert.equal(f.w.eval('accountManagement.view'),'list');f.w.confirmDeactivateAccount(0);assert.equal(f.w.eval('accountManagement.view'),'list')}finally{f.close()}
});
test('late account list and create responses cannot restore private UI after logout',async()=>{
 const f=await fixture({delay:35});try{const pending=f.w.openAccounts();await wait(3);f.w.logout();await pending;assert.equal(f.w.eval('accountManagement.accounts.length'),0);assert.equal(f.w.eval('session'),null);assert.equal(f.w.document.querySelector('#accountManagementButton'),null)}finally{f.close()}
 const g=await fixture();try{await createForm(g);g.state.delay=35;const pending=g.w.createManagedAccount();await wait(3);g.w.logout();await pending;assert.equal(g.w.eval('accountManagement.payload'),null);assert.equal(g.w.eval('accountManagement.accounts.length'),0);assert.ok(g.w.document.querySelector('#email'))}finally{g.close()}
});
test('late create after leaving account page does not navigate or recreate password form',async()=>{
 const f=await fixture();try{await createForm(f);f.state.delay=35;const pending=f.w.createManagedAccount();await wait(3);f.w.go('home');await pending;assert.equal(f.w.eval('page'),'home');assert.ok(f.w.document.querySelector('#homeCapture'));assert.equal(f.w.eval('accountManagement.payload'),null)}finally{f.close()}
});
test('account names, email and store labels render as text',async()=>{
 const f=await fixture();try{f.state.accounts[1].display_name='<img src=x onerror=alert(1)>';f.state.stores[0].name='<svg onload=alert(1)>';await f.w.openAccounts();assert.match(f.w.document.querySelector('#app').textContent,/<img/);assert.equal(f.w.document.querySelector('#app img,#app svg'),null);f.w.editAccountStores(1);assert.equal(f.w.document.querySelector('#app img,#app svg'),null)}finally{f.close()}
});
test('inactive boot rejects access, active session clears when disabled or demoted',async()=>{
 const f=await fixture({active:false});try{assert.equal(f.w.eval('session'),null);assert.match(f.w.document.querySelector('#loginErr').textContent,/deactivated/)}finally{f.close()}
 for(const changed of [{active:false},{role:'partner'}]){const g=await fixture();try{await g.w.openAccounts();Object.assign(g.state,changed);await g.w.refreshAll();assert.equal(g.w.eval('session'),null);assert.equal(g.w.eval('accountManagement.accounts.length'),0);assert.equal(g.w.eval('tickets.length'),0);assert.match(g.w.document.querySelector('#loginErr').textContent,/access has changed/)}finally{g.close()}}
});

test('rejected provider password can be changed while original request identity stays frozen',async()=>{
 const f=await fixture({rejectPassword:true});try{await createForm(f);await f.w.createManagedAccount();assert.match(f.w.document.querySelector('#accountActionStatus').textContent,/password was rejected/);assert.equal(f.w.document.querySelector('#accountName').disabled,true);assert.equal(f.w.document.querySelector('#accountPassword').disabled,false);f.value('accountPassword','Mock-stronger-password-456');await f.w.createManagedAccount();const req=f.state.requests.filter(r=>r.action==='create');assert.equal(req.length,2);assert.equal(req[0].requestId,req[1].requestId);assert.equal(req[1].password,'Mock-stronger-password-456');assert.equal(req[0].email,req[1].email)}finally{f.close()}
});
test('unfinished server reservation can resume after local form is gone without stored passwords',async()=>{
 const f=await fixture();try{f.state.pendingRequests=[{request_id:'30000000-0000-4000-8000-000000000001',email:'resume@example.invalid',display_name:'Resume Person',role:'partner',store_ids:[A,B]}];await f.w.openAccounts();assert.match(f.w.document.querySelector('#app').textContent,/Finish setup/);f.w.resumeManagedAccount(0);assert.equal(f.w.document.querySelector('#accountEmail').value,'resume@example.invalid');assert.equal(f.w.document.querySelector('#accountEmail').disabled,true);assert.equal(f.w.document.querySelector('#accountPassword').value,'');assert.equal(f.w.document.querySelector('#accountPassword').disabled,false);assert.match(f.w.document.querySelector('#app').textContent,/password stays unchanged/);f.value('accountPassword','Mock-test-password-123');await f.w.createManagedAccount();const req=f.state.requests.find(r=>r.action==='create');assert.equal(req.requestId,'30000000-0000-4000-8000-000000000001');assert.deepEqual(req.storeIds,[A,B]);assert.equal(f.w.eval('accountManagement.payload'),null)}finally{f.close()}
});
test('legacy shared store binding cannot be reassigned by the UI',async()=>{
 const f=await fixture();try{f.state.accounts[1].is_legacy_shared=true;await f.w.openAccounts();assert.match(f.w.document.querySelector('#app').textContent,/Shared store login/);const card=f.w.document.querySelectorAll('.accountCard')[1];assert.doesNotMatch(card.textContent,/Assign stores/);f.w.editAccountStores(1);assert.equal(f.w.eval('accountManagement.view'),'list');f.w.confirmDeactivateAccount(1);assert.equal(f.w.eval('accountManagement.view'),'deactivate')}finally{f.close()}
});

test('recovered Auth identity explicitly confirms original password unchanged',async()=>{
 const f=await fixture({passwordUnchanged:true});try{await createForm(f);await f.w.createManagedAccount();assert.match(f.w.document.querySelector('#accountListStatus').textContent,/original password is unchanged/);assert.equal(f.w.eval('accountManagement.payload'),null)}finally{f.close()}
});

test('password validates UTF-8 byte limit before reserve, including non-Latin characters',async()=>{
 const f=await fixture();try{await createForm(f);for(const password of ['x'.repeat(73),'密'.repeat(25),'🔐'.repeat(19)]){f.value('accountPassword',password);await f.w.createManagedAccount();assert.match(f.w.document.querySelector('#accountActionStatus').textContent,/72 UTF-8 bytes/)}assert.equal(f.state.requests.filter(r=>r.action==='create').length,0);f.value('accountPassword','密'.repeat(24));await f.w.createManagedAccount();assert.equal(f.state.requests.filter(r=>r.action==='create').length,1)}finally{f.close()}
});

test('replayed creation of later-disabled account never announces it active or re-enables it',async()=>{
 const f=await fixture({createdInactive:true,passwordUnchanged:true});try{await createForm(f);await f.w.createManagedAccount();assert.match(f.w.document.querySelector('#accountListStatus').textContent,/inactive.*not been re-enabled/);assert.equal(f.state.accounts.at(-1).active,false)}finally{f.close()}
});

async function storeForm(f,inline=false){
 if(inline)await createForm(f);else await f.w.openAccounts();
 f.w.startNewStore(inline);f.value('newStoreName','  New Fictional Store  ');f.value('newStoreCode',' xx9 ');
}
test('new store standalone normalizes fields, suppresses repeat clicks and creates no account',async()=>{
 const f=await fixture({delay:20});try{await storeForm(f);await Promise.all([f.w.createManagedStore(),f.w.createManagedStore()]);const req=f.state.requests.filter(r=>r.action==='create_store');assert.equal(req.length,1);assert.equal(req[0].name,'New Fictional Store');assert.equal(req[0].code,'XX9');assert.equal(f.state.accounts.length,3);assert.equal(f.state.stores.length,3);assert.match(f.w.document.querySelector('#accountListStatus').textContent,/created/);f.w.startNewAccount();assert.equal(f.w.document.querySelectorAll('[name="accountStores"]').length,3)}finally{f.close()}
});
test('inline new store preserves account draft and selects new store without granting access',async()=>{
 for(const role of ['store','partner']){const f=await fixture();try{await storeForm(f,true);f.value('accountRole',role);f.w.changeAccountRole();await f.w.createManagedStore();assert.equal(f.w.document.querySelector('#accountName').value,'New Person');assert.equal(f.w.document.querySelector('#accountPassword').value,'Mock-test-password-123');assert.equal(f.state.accounts.length,3);assert.equal(f.w.document.querySelector('#accountSubmit').disabled,false);const selected=Array.from(f.w.selectedAccountStores());assert.equal(selected.includes(f.state.stores.at(-1).id),true);assert.equal(selected.length,role==='store'?1:2);await f.w.createManagedAccount();assert.equal(f.state.requests.filter(r=>r.action==='create').length,1)}finally{f.close()}}
});
test('new store validation rejects blank name, bad code and known duplicates before network',async()=>{
 const f=await fixture();try{await storeForm(f);for(const [name,code,message] of [['','XX','store name'],['Name','a','2–8'],['Name','two words','2–8'],['Name','hwd','already in use']]){f.value('newStoreName',name);f.value('newStoreCode',code);await f.w.createManagedStore();assert.match(f.w.document.querySelector('#newStoreStatus').textContent,new RegExp(message))}assert.equal(f.state.requests.filter(r=>r.action==='create_store').length,0)}finally{f.close()}
});
test('lost store response freezes exact retry payload and idempotently recovers',async()=>{
 const f=await fixture({lostStore:true});try{await storeForm(f);await f.w.createManagedStore();assert.equal(f.w.document.querySelector('#newStoreFields').disabled,true);assert.match(f.w.document.querySelector('#newStoreStatus').textContent,/not confirmed/);await f.w.createManagedStore();const requests=f.state.requests.filter(r=>r.action==='create_store');assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);assert.equal(f.state.stores.length,3);assert.equal(f.w.eval('accountManagement.storeRequest'),null)}finally{f.close()}
});
test('server duplicate store code is recoverable without freezing fields',async()=>{
 const f=await fixture({storeError:'store_code_exists'});try{await storeForm(f);await f.w.createManagedStore();assert.equal(f.w.document.querySelector('#newStoreFields').disabled,false);assert.equal(f.w.eval('accountManagement.storeRequest'),null);assert.match(f.w.document.querySelector('#newStoreStatus').textContent,/already in use/);f.state.storeError=null;f.value('newStoreCode','XX8');await f.w.createManagedStore();assert.equal(f.state.stores.at(-1).code,'XX8')}finally{f.close()}
});
test('cancel inline store preserves account values and blocks accidental account submission while open',async()=>{
 const f=await fixture();try{await storeForm(f,true);await f.w.createManagedAccount();assert.equal(f.state.requests.filter(r=>r.action==='create').length,0);f.w.cancelInlineStore();assert.equal(f.w.document.querySelector('#accountName').value,'New Person');assert.equal(f.w.document.querySelector('#newStoreName').value,'');assert.equal(f.w.document.querySelector('#accountSubmit').disabled,false);assert.equal(f.state.requests.filter(r=>r.action==='create_store').length,0)}finally{f.close()}
});
test('late store responses cannot restore UI after back, cancel, logout or account demotion',async()=>{
 for(const exit of ['back','cancel','logout','demote']){const f=await fixture();try{await storeForm(f,exit==='cancel');f.state.delay=30;const pending=f.w.createManagedStore();await wait(2);if(exit==='back')f.w.accountBack();else if(exit==='cancel')f.w.cancelInlineStore();else if(exit==='logout')f.w.logout();else{f.state.role='hq';await f.w.refreshAll()}await pending;assert.equal(f.w.eval('accountManagement.storeRequest'),null);if(exit==='cancel'){assert.equal(f.w.document.querySelector('#inlineStorePanel').classList.contains('hidden'),true);assert.equal(f.w.selectedAccountStores().length,1);assert.equal(f.w.selectedAccountStores()[0],A)}else assert.equal(f.w.document.querySelector('#newStoreName'),null)}finally{f.close()}}
});
test('nonadmin cannot open or directly submit new-store flow',async()=>{
 const f=await fixture({role:'hq'});try{f.w.startNewStore();await f.w.createManagedStore();assert.equal(f.state.requests.length,0);assert.equal(f.w.document.querySelector('#newStoreButton'),null)}finally{f.close()}
});

test('store replay after rename or deactivation completes without silently assigning changed store',async()=>{
 for(const changed of ['name','active']){const f=await fixture({lostStore:true});try{await storeForm(f,true);await f.w.createManagedStore();const created=f.state.stores.at(-1);if(changed==='name')created.name='Changed Fictional Name';else created.active=false;await f.w.createManagedStore();assert.equal(f.w.eval('accountManagement.storeRequest'),null);assert.equal(f.w.document.querySelector('#inlineStorePanel').classList.contains('hidden'),true);assert.equal(f.w.document.querySelector('#accountPassword').value,'Mock-test-password-123');assert.deepEqual(Array.from(f.w.selectedAccountStores()),[A]);assert.match(f.w.document.querySelector('#accountActionStatus').textContent,changed==='name'?/details have changed/:/now inactive/)}finally{f.close()}}
});

test('HQ refresh sees newly created stores and updates ticket labels without an app restart',async()=>{
 const f=await fixture({role:'hq'});try{const added={id:'20000000-0000-4000-8000-000000000098',code:'NEW5',name:'Fictional Remote Store',active:true};f.state.stores.push(added);await f.w.refreshAll();f.w.go('stores');assert.match(f.w.document.querySelector('#app').textContent,/Fictional Remote Store/);assert.equal(f.w.eval('stores.length'),3);assert.equal(f.w.ticketId({store_id:added.id,ticket_no:7}),'NEW5-00007');assert.equal(f.state.requests.length,0)}finally{f.close()}
});
test('background store refresh preserves an inline account/store draft',async()=>{
 const f=await fixture();try{await storeForm(f,true);await f.w.refreshAll();assert.equal(f.w.document.querySelector('#newStoreName').value,'  New Fictional Store  ');assert.equal(f.w.document.querySelector('#accountPassword').value,'Mock-test-password-123');assert.equal(f.w.document.querySelector('#inlineStorePanel').classList.contains('hidden'),false)}finally{f.close()}
});
test('late store refresh cannot restore global store data after logout',async()=>{
 const f=await fixture();try{f.state.storeDelay=40;const reading=f.w.refreshStores();await wait(2);f.w.logout();await reading;assert.equal(f.w.eval('stores.length'),0)}finally{f.close()}
});
