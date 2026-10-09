const test=require('node:test');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const fakePassword='Only-a-test-value-123!';
const createBody=()=>({action:'create',requestId:id(100),email:'Person@Example.Test',displayName:'Person',role:'partner',storeIds:[id(20),id(21)],password:fakePassword});
const sampleAccount={user_id:id(10),email:'person@example.test',display_name:'Person',role:'partner',active:true,store_ids:[id(20),id(21)]};
async function harness(options={}) {
 const {createAccountHandler}=await import(pathToFileURL(path.resolve(__dirname,'../supabase/functions/ops-admin-accounts/handler.mjs')));
 const calls=[];let reservations=0;
 const admin={
  from:table=>{calls.push(['from',table]);return{select:columns=>({eq:(field,value)=>({maybeSingle:async()=>({data:options.profile===undefined?{role:'admin',active:true}:options.profile,error:options.profileError||null})})})};},
  rpc:async(name,args)=>{
   calls.push(['rpc',name,args]);
   if(options.rpc) return options.rpc(name,args,++reservations);
   if(name.endsWith('_list')) return{data:{accounts:[sampleAccount],stores:[]},error:null};
   if(name.endsWith('_reserve')) return{data:options.reserve||{complete:false,user_id:null},error:null};
   return{data:sampleAccount,error:null};
  },
  auth:{admin:{createUser:async params=>{calls.push(['createUser',params]);return options.createResult||{data:{user:{id:id(10)}},error:null};}}},
 };
 const caller={auth:{getUser:async token=>{calls.push(['getUser',token]);return options.identity||{data:{user:{id:id(1),user_metadata:{role:'admin'}}},error:null};}}};
 const handler=createAccountHandler({createClient:(url,key,config)=>{calls.push(['client',key,config]);return key==='service-test'?admin:caller;},env:name=>({SUPABASE_URL:'https://project.test',SUPABASE_ANON_KEY:'anon-test',SUPABASE_SERVICE_ROLE_KEY:'service-test'})[name]});
 async function send(body={action:'list'},extra={}){
  const request={method:'POST',headers:{Authorization:'Bearer verified-token','Content-Type':'application/json',Origin:'https://hanokops.local',...extra.headers},body:JSON.stringify(body),...extra};
  if(extra.method==='OPTIONS'||extra.method==='GET')delete request.body;
  const result=await handler(new Request('https://project.test/functions/v1/ops-admin-accounts',request));
  const text=await result.text();return{status:result.status,headers:result.headers,body:text?JSON.parse(text):null};
 }
 return{calls,send};
}
test('account endpoint CORS and method boundaries',async()=>{
 const h=await harness();
 assert.equal((await h.send({}, {method:'OPTIONS'})).status,204);
 assert.equal((await h.send({}, {method:'GET'})).status,405);
 const denied=await h.send({}, {headers:{Origin:'https://evil.example'}});assert.equal(denied.status,403);assert.equal(denied.headers.get('access-control-allow-origin'),null);
 for(const origin of ['https://hanokops.local','https://baogaolaoban-report.vercel.app']) {
  const result=await h.send({action:'list'},{headers:{Authorization:'Bearer verified-token','Content-Type':'application/json',Origin:origin}});
  assert.equal(result.status,200);assert.equal(result.headers.get('access-control-allow-origin'),origin);assert.equal(result.headers.get('cache-control'),'no-store');
 }
 assert.equal(h.calls.filter(c=>c[0]==='rpc').length,2);
});
test('account endpoint verifies JWT and live active-admin DB role, ignoring spoofed metadata',async()=>{
 for(const identity of [{data:{user:null},error:{message:'Bad token'}},{data:{user:null},error:null}]){
  const h=await harness({identity});assert.equal((await h.send()).status,401);assert.equal(h.calls.some(c=>c[0]==='rpc'),false);
 }
 for(const profile of [null,{role:'pending',active:true},{role:'hq',active:true},{role:'store',active:true},{role:'partner',active:true},{role:'admin',active:false},{role:'admin'}]){
  const h=await harness({profile});assert.equal((await h.send()).status,403);assert.equal(h.calls.some(c=>c[0]==='rpc'),false);
 }
 const h=await harness();assert.equal((await h.send({}, {headers:{'Content-Type':'application/json'}})).status,401);
});
test('account endpoint validates roles, IDs, bounded fields and unique assignments before mutations',async()=>{
 const invalid=[{role:'admin'},{role:'hq'},{role:'pending'},{requestId:'bad'},{email:'not-an-email'},{email:'a'.repeat(250)+'@example.test'},
  {displayName:''},{displayName:'x'.repeat(101)},{password:'short'},{password:'x'.repeat(73)},{password:'密'.repeat(25)},{password:'😀'.repeat(19)},{password:'😀'.repeat(6)},{storeIds:[]},{storeIds:['bad']},
  {storeIds:[id(20),id(20)]},{role:'store',storeIds:[id(20),id(21)]}];
 for(const change of invalid){const h=await harness();assert.equal((await h.send({...createBody(),...change})).status,400,JSON.stringify(change));assert.equal(h.calls.some(c=>c[0]==='rpc'||c[0]==='createUser'),false);}
 for(const body of [{action:'reset'},{action:'deactivate',userId:'bad'},{action:'assign',userId:id(10),storeIds:[]},null]){
  const h=await harness();assert.equal((await h.send(body)).status,400);
 }
});
test('account endpoint rejects oversized and malformed requests without echoing secrets',async()=>{
 const h=await harness();
 assert.equal((await h.send({}, {body:'{bad'})).status,400);
 assert.equal((await h.send({}, {body:JSON.stringify({password:'x'.repeat(17000)})})).status,413);
 assert.equal((await h.send({}, {headers:{Authorization:'Bearer verified-token','Content-Type':'text/plain'}})).status,415);
});
test('account create reserves, creates Auth exactly once, and finalizes without writing password into RPC',async()=>{
 const h=await harness();const result=await h.send(createBody());assert.equal(result.status,200);assert.equal(result.body.ok,true);assert.equal(result.body.password_unchanged,false);
 const operations=h.calls.filter(c=>['rpc','createUser'].includes(c[0]));assert.deepEqual(operations.map(c=>c[0]==='rpc'?c[1]:c[0]),['ops_admin_accounts_reserve','createUser','ops_admin_accounts_finalize']);
 const params=operations[1][1];assert.equal(params.password,fakePassword);assert.equal(params.email,'person@example.test');assert.deepEqual(params.app_metadata,{ops_account_request_id:id(100)});
 assert.equal(JSON.stringify(h.calls.filter(c=>c[0]==='rpc')).includes(fakePassword),false);assert.equal(JSON.stringify(result.body).includes(fakePassword),false);
});
test('completed create retries return existing result and never reset passwords',async()=>{
 const h=await harness({reserve:{complete:true,account:{...sampleAccount,active:false},user_id:id(10)}});
 const result=await h.send(createBody());assert.equal(result.status,200);assert.equal(result.body.account.active,false);assert.equal(result.body.password_unchanged,true);assert.equal(h.calls.some(c=>c[0]==='createUser'),false);
});
test('partial create resumes the verified pending Auth user without changing credentials',async()=>{
 const h=await harness({reserve:{complete:false,user_id:id(10)}});
 const result=await h.send(createBody());assert.equal(result.status,200);assert.equal(result.body.password_unchanged,true);assert.equal(h.calls.some(c=>c[0]==='createUser'),false);
});
test('lost Auth success response is recovered without a second Auth mutation',async()=>{
 let reserveCalls=0;
 const h=await harness({createResult:{data:{user:null},error:{message:'Lost connection'}},rpc:async name=>({data:name.endsWith('_reserve')?{complete:false,user_id:++reserveCalls===1?null:id(10)}:sampleAccount,error:null})});
 assert.equal((await h.send(createBody())).status,200);assert.equal(h.calls.filter(c=>c[0]==='createUser').length,1);
});
test('unrelated duplicate and conflicting idempotency requests never touch Auth',async()=>{
 for(const code of ['email_exists','email_reserved','request_conflict']){
  const h=await harness({rpc:async()=>({data:null,error:{message:code}})});const result=await h.send(createBody());assert.equal(result.status,409);assert.equal(result.body.error,code);assert.equal(h.calls.some(c=>c[0]==='createUser'),false);
 }
});
test('known Auth failure and finalization outages stay retryable with sanitized errors',async()=>{
 const h=await harness({createResult:{data:{user:null},error:{message:`Provider leak ${fakePassword}`}}});const result=await h.send(createBody());assert.equal(result.status,503);assert.equal(result.body.retryable,true);assert.equal(JSON.stringify(result.body).includes(fakePassword),false);
 const finalized=await harness({reserve:{complete:false,user_id:id(10)},rpc:async name=>name.endsWith('_reserve')?{data:{complete:false,user_id:id(10)},error:null}:{data:null,error:{message:`DB error ${fakePassword}`}}});
 const second=await finalized.send(createBody());assert.equal(second.status,503);assert.equal(second.body.retryable,true);assert.equal(finalized.calls.some(c=>c[0]==='createUser'),false);
});
test('assignment/deactivation target verified actor and reject self-management',async()=>{
 for(const action of ['assign','deactivate']){
  const h=await harness();assert.equal((await h.send({action,userId:id(1),storeIds:[id(20)]})).status,403);assert.equal(h.calls.some(c=>c[0]==='rpc'),false);
  const good=await harness();assert.equal((await good.send({action,userId:id(10),storeIds:[id(20)],actorId:id(999)})).status,200);
  assert.equal(good.calls.find(c=>c[0]==='rpc')[2].p_actor_id,id(1));
 }
});

test('canonical pending-request recovery uses server ID for Auth marker and finalization',async()=>{
 const h=await harness({reserve:{complete:false,request_id:id(555),user_id:null}});
 assert.equal((await h.send(createBody())).status,200);
 assert.equal(h.calls.find(c=>c[0]==='createUser')[1].app_metadata.ops_account_request_id,id(555));
 assert.equal(h.calls.find(c=>c[0]==='rpc'&&c[1]==='ops_admin_accounts_finalize')[2].p_request_id,id(555));
});

async function legacyHarness(overrides={}) {
 const fs=require('node:fs'),vm=require('node:vm');
 const {stripTypeScriptTypes}=require('node:module');
 let source=fs.readFileSync(path.resolve(__dirname,'../supabase/functions/ops-admin-store-user/index.ts'),'utf8').replace(/^import .*;\n/gm,'');
 source=stripTypeScriptTypes(source);
 const resets=[];let handler;
 const profile=overrides.adminProfile===undefined?{role:'admin',active:true}:overrides.adminProfile;
 const shared=overrides.shared===undefined?{user_id:id(10),email:'store.hwd@hanokops.invalid',role:'store',active:true,is_legacy_shared:true,store_id:id(20)}:overrides.shared;
 const admin={from:table=>{const builder={select:()=>builder,eq:()=>builder,maybeSingle:async()=>({data:table==='ops_profiles'?(builder.done++?shared:profile):null,error:null}),single:async()=>({data:{id:id(20),code:'HWD',name:'Hanok Woden'},error:null}),done:0};
  if(table==='ops_profiles'){builder.maybeSingle=async()=>({data:admin.reads++?shared:profile,error:null});}return builder;},reads:0,
  auth:{admin:{getUserById:async()=>({data:{user:{id:id(10),email:overrides.authEmail||'store.hwd@hanokops.invalid'}},error:null}),updateUserById:async(userId,params)=>{resets.push({userId,params});return{data:{user:{id:userId}},error:null};}}}};
 const caller={auth:{getUser:async()=>({data:{user:{id:id(1)}},error:null})}};
 vm.runInNewContext(source,{Request,Response,JSON,TextEncoder,createClient:(_url,key)=>key==='service'?admin:caller,Deno:{env:{get:name=>name==='SUPABASE_SERVICE_ROLE_KEY'?'service':'public'},serve:fn=>{handler=fn;}}});
 const result=await handler(new Request('https://project.test/legacy',{method:'POST',headers:{Origin:'https://baogaolaoban-report.vercel.app',Authorization:'Bearer verified-token','Content-Type':'application/json'},body:JSON.stringify({storeCode:'HWD',password:overrides.password===undefined?fakePassword:overrides.password})}));
 return{result,resets,body:await result.json()};
}
test('legacy live-v2 route keeps exact origin and can only reset marked active original shared account',async()=>{
 const good=await legacyHarness();assert.equal(good.result.status,200);assert.equal(good.result.headers.get('access-control-allow-origin'),'https://baogaolaoban-report.vercel.app');assert.equal(good.resets.length,1);assert.deepEqual(Object.keys(good.resets[0].params),['password']);
 for(const shared of [null,{role:'store',active:false,is_legacy_shared:true},{role:'store',active:true,is_legacy_shared:false},{role:'partner',active:true,is_legacy_shared:true}]){
  const bad=await legacyHarness({shared});assert.equal(bad.result.status,409);assert.equal(bad.resets.length,0);
 }
 const mismatch=await legacyHarness({authEmail:'personal@example.test'});assert.equal(mismatch.result.status,409);assert.equal(mismatch.resets.length,0);
 for(const adminProfile of [{role:'hq',active:true},{role:'admin',active:false},null]){const bad=await legacyHarness({adminProfile});assert.equal(bad.result.status,403);assert.equal(bad.resets.length,0);}
});

test('password byte limits accept valid multibyte values and reject provider-incompatible values before Auth/reservation',async()=>{
 for(const password of ['a'.repeat(72),'密'.repeat(24),'😀'.repeat(18)]) {
  const h=await harness();assert.equal((await h.send({...createBody(),password})).status,200);
 }
 for(const password of ['a'.repeat(73),'密'.repeat(25),'😀'.repeat(19)]) {
  const h=await legacyHarness({password});assert.equal(h.result.status,400);assert.equal(h.body.error,'invalid_password');assert.equal(h.resets.length,0);
 }
});

const storeBody=()=>({action:'create_store',requestId:id(700),name:'  新店 😀  ',code:' nw01 '});
const sampleStore={id:id(701),name:'新店 😀',code:'NW01',active:true};
test('store creation verifies JWT and live administrator role before any mutation',async()=>{
 for(const profile of [null,{role:'hq',active:true},{role:'store',active:true},{role:'partner',active:true},{role:'pending',active:true},{role:'admin',active:false}]) {
  const h=await harness({profile});const result=await h.send(storeBody());assert.equal(result.status,403);assert.equal(result.body.error,'admin_required');
  assert.equal(h.calls.some(c=>c[0]==='rpc'||c[0]==='createUser'),false);
 }
 for(const identity of [{data:{user:null},error:{message:'Invalid token'}},{data:{user:null},error:null}]) {
  const h=await harness({identity});assert.equal((await h.send(storeBody())).status,401);assert.equal(h.calls.some(c=>c[0]==='rpc'),false);
 }
 const noAuth=await harness();assert.equal((await noAuth.send(storeBody(),{headers:{'Content-Type':'application/json'}})).status,401);
 assert.equal(noAuth.calls.length,0);
 const unavailable=await harness({profileError:{message:'Database down'}});assert.equal((await unavailable.send(storeBody())).status,503);
 assert.equal(unavailable.calls.some(c=>c[0]==='rpc'),false);
});
test('store creation normalizes names/codes and uses only the verified actor and atomic store RPC',async()=>{
 const h=await harness({rpc:async()=>({data:sampleStore,error:null})});
 const result=await h.send({...storeBody(),actorId:id(999),active:false,storeIds:[id(20)],role:'admin',email:'unrequested@example.test',password:fakePassword});
 assert.equal(result.status,200);assert.deepEqual(result.body,{ok:true,request_id:id(700),store:sampleStore});assert.equal(result.headers.get('cache-control'),'no-store');
 assert.deepEqual(h.calls.filter(c=>c[0]==='rpc'),[['rpc','ops_admin_stores_create',{p_actor_id:id(1),p_request_id:id(700),p_name:'新店 😀',p_code:'NW01'}]]);
 assert.equal(h.calls.some(c=>c[0]==='createUser'),false);
 assert.deepEqual(h.calls.filter(c=>c[0]==='from'),[['from','ops_profiles']]);
});
test('store creation rejects invalid Unicode names, codes and request IDs without mutation',async()=>{
 const invalid=[
  [{requestId:null},'invalid_request_id'],[{requestId:'not-a-uuid'},'invalid_request_id'],
  [{name:null},'invalid_store_name'],[{name:123},'invalid_store_name'],[{name:''},'invalid_store_name'],[{name:' \t\n\u00a0\u3000 '},'invalid_store_name'],
  [{name:'店'.repeat(101)},'invalid_store_name'],[{name:'😀'.repeat(101)},'invalid_store_name'],[{name:'Null\u0000name'},'invalid_store_name'],[{name:'\ud800'},'invalid_store_name'],
  [{code:null},'invalid_store_code'],[{code:123},'invalid_store_code'],[{code:'A'},'invalid_store_code'],[{code:'ABCDEFGHI'},'invalid_store_code'],
  [{code:'AB-CD'},'invalid_store_code'],[{code:'AB CD'},'invalid_store_code'],[{code:'中文'},'invalid_store_code'],[{code:'ß1'},'invalid_store_code'],
 ];
 for(const [change,error] of invalid) {
  const h=await harness();const result=await h.send({...storeBody(),...change});assert.equal(result.status,400,JSON.stringify(change));assert.equal(result.body.error,error);
  assert.equal(h.calls.some(c=>c[0]==='rpc'||c[0]==='createUser'),false);
 }
});
test('store creation counts Unicode code points, supports trimmed limits, and accepts ASCII codes',async()=>{
 for(const name of ['店','店'.repeat(100),'😀'.repeat(100),'\t\n\u00a0\u3000Name\uFEFF']) {
  const h=await harness({rpc:async()=>({data:sampleStore,error:null})});assert.equal((await h.send({...storeBody(),name})).status,200);
  assert.equal(h.calls.find(c=>c[0]==='rpc')[2].p_name,name.trim());
 }
 for(const code of ['aa','12345678','\t ab12 \u3000']) {
  const h=await harness({rpc:async()=>({data:sampleStore,error:null})});assert.equal((await h.send({...storeBody(),code})).status,200);
  assert.equal(h.calls.find(c=>c[0]==='rpc')[2].p_code,code.trim().toUpperCase());
 }
});
test('store creation maps database authorization/validation/conflict errors without exposing raw errors',async()=>{
 for(const [error,status] of [['admin_required',403],['invalid_request_id',400],['invalid_store_name',400],['invalid_store_code',400],['store_code_exists',409],['request_conflict',409]]) {
  const h=await harness({rpc:async()=>({data:null,error:{message:error}})});const result=await h.send(storeBody());
  assert.equal(result.status,status);assert.deepEqual(result.body,{error});assert.equal(h.calls.some(c=>c[0]==='createUser'),false);
 }
 const h=await harness({rpc:async()=>({data:null,error:{message:'Private SQL provider detail'}})});const result=await h.send(storeBody());
 assert.equal(result.status,503);assert.deepEqual(result.body,{error:'database_unavailable',retryable:true});
});
test('store retries retain their request ID and return inactive replay without creating any Auth user',async()=>{
 const h=await harness({rpc:async()=>({data:{...sampleStore,active:false},error:null})});
 const results=await Promise.all([h.send(storeBody()),h.send(storeBody())]);
 for(const result of results) assert.deepEqual(result.body,{ok:true,request_id:id(700),store:{...sampleStore,active:false}});
 assert.equal(h.calls.filter(c=>c[0]==='rpc').length,2);assert.equal(h.calls.some(c=>c[0]==='createUser'),false);
 assert.ok(h.calls.filter(c=>c[0]==='rpc').every(c=>c[2].p_request_id===id(700)));
 const renamed={...sampleStore,name:'Renamed store',code:'NEW1'};
 const renamedHandler=await harness({rpc:async()=>({data:renamed,error:null})});
 assert.deepEqual((await renamedHandler.send(storeBody())).body,{ok:true,request_id:id(700),store:renamed});
});
