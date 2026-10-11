const {test}=require('node:test'),assert=require('node:assert/strict');
const {createSessionStore}=require('../mobile/session');
const {createGate}=require('../mobile/access');
const token=(sub,exp)=>'e30.'+Buffer.from(JSON.stringify({sub,exp})).toString('base64url')+'.test';
const session=(id='u',exp=10,refresh='r1')=>({user:{id},access_token:token(id,exp),refresh_token:refresh});
const profile=(role='hq',id='u')=>({user_id:id,active:true,role});
function storage(){const m=new Map();return {getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k),m};}
function bridge(initial){let n=initial,clears=0;return {getStoredSession:()=>JSON.stringify(n),saveRoleSession:(a,r,role)=>{n={access_token:a,refresh_token:r,role};return true},updateRoleSession:(a,r,role,expected)=>{if(n?.refresh_token!==expected)return false;n={access_token:a,refresh_token:r,role};return true},clearSessionIfCurrent:expected=>{if(n?.refresh_token!==expected)return false;n=null;clears++;return true},get data(){return n},set data(v){n=v},get clears(){return clears}};}
test('new verified login switches single local/native owner while retaining Projects and personal drafts',()=>{
 const s=storage(),b=bridge(session('old')),m=createSessionStore(s,b);s.setItem('hanokops_session',JSON.stringify(session('old')));s.setItem('hanokops_projects','keep');s.setItem('draft:old','keep');s.setItem('hanokops_pending_ticket','old-ticket');
 m.commit(session(),{sessionKey:'hanok_store_session',workspace:'store'},profile('store'));
 assert.equal(s.getItem('hanokops_session'),null);assert.equal(s.getItem('reportboss_workspace'),'store');assert.equal(s.getItem('hanokops_pending_ticket'),null);assert.equal(s.getItem('hanokops_projects'),'keep');assert.equal(s.getItem('draft:old'),'keep');assert.equal(b.data.role,'store');
});
test('native same-owner newer session hydrates but never authorizes role',()=>{
 const s=storage(),b=bridge(session('u',20,'r2')),m=createSessionStore(s,b);
 const next=m.hydrate(session());assert.equal(next.refresh_token,'r2');m.sync(next,{...profile(),active:false});assert.equal(b.data.role,undefined);
});
test('CAS rejection rehydrates rotation without overwriting newer native token',()=>{
 const b=bridge(session()),m=createSessionStore(storage(),b);m.hydrate(session());b.data=session('u',30,'r3');
 const next=m.sync(session('u',20,'r2'),profile());assert.equal(next.refresh_token,'r3');assert.equal(b.data.refresh_token,'r3');
});
test('different native owner blocks stale hydration, save and logout clearing',()=>{
 const s=storage(),b=bridge(session('new',30,'new')),m=createSessionStore(s,b);s.setItem('hanokops_session',JSON.stringify(session()));s.setItem('hanok_store_session',JSON.stringify(session('new',30,'new')));
 assert.throws(()=>m.hydrate(session()),/account changed/);assert.throws(()=>m.sync(session(),profile()),/account changed/);assert.equal(m.clear(session()),false);assert.equal(b.data.refresh_token,'new');assert.equal(JSON.parse(s.getItem('hanok_store_session')).user.id,'new');
});
test('logout clears same-owner rotated native token and both old workspace sessions',()=>{
 const s=storage(),b=bridge(session('u',30,'r3')),m=createSessionStore(s,b);for(const key of ['hanokops_session','hanok_store_session'])s.setItem(key,JSON.stringify(session()));
 assert.equal(m.clear(session()),true);assert.equal(b.data,null);assert.equal(s.getItem('hanokops_session'),null);assert.equal(s.getItem('hanok_store_session'),null);
});
test('ambiguous old accounts are not auto-restored without a workspace hint',()=>{
 const s=storage(),m=createSessionStore(s);s.setItem('hanokops_session',JSON.stringify(session()));s.setItem('hanok_store_session',JSON.stringify(session('other')));assert.equal(m.saved(),null);s.setItem('reportboss_workspace','store');assert.equal(m.saved().user.id,'other');
});
test('restoration refreshes expired token and derives route from live role',async()=>{
 let calls=0,commit;const gate=createGate({verifyUser:async()=>{if(!calls++)throw Object.assign(Error('Expired'),{status:401});return{id:'u'}},refreshSession:async()=>session('u',20,'r2'),profile:async()=>profile('partner'),stores:async()=>[{id:'s',active:true}],commit:(...args)=>commit=args});
 const route=await gate.restore(session());assert.equal(route.workspace,'store');assert.equal(commit[3].restoring,true);assert.equal(commit[0].refresh_token,'r2');
});
test('restoration refuses refreshed identity mismatch',async()=>{
 const gate=createGate({verifyUser:async()=>{throw Object.assign(Error('Expired'),{status:401})},refreshSession:async()=>session('other'),commit(){throw Error('Must not commit')}});
 await assert.rejects(gate.restore(session()),/identity changed/);
});
