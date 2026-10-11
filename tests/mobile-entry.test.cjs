const {test}=require('node:test');
const assert=require('node:assert/strict');
const {routeFor,createGate}=require('../mobile/access');
const profile=(role,extra={})=>({user_id:'u',active:true,role,store_id:'s1',...extra});
const stores=[{id:'s1',active:true},{id:'s2',active:true},{id:'s3',active:false}];
for(const role of ['hq','admin'])test(role+' uses HQ only from Boss entry',()=>{
 assert.equal(routeFor('boss','u',profile(role)).workspace,'hq');
 assert.throws(()=>routeFor('staff','u',profile(role)),/Boss Login/);
});
test('partner sees only active server-returned stores and never HQ',()=>{
 assert.deepEqual(routeFor('boss','u',profile('partner'),stores),{workspace:'store',url:'./store.html',sessionKey:'hanok_store_session',storeIds:['s1','s2']});
 assert.throws(()=>routeFor('staff','u',profile('partner'),stores),/Boss Login/);
});
test('staff stays in bound store; Boss selection never elevates access',()=>{
 assert.deepEqual(routeFor('staff','u',profile('store'),stores).storeIds,['s1']);
 assert.throws(()=>routeFor('boss','u',profile('store'),stores),/Staff Login/);
});
for(const bad of [null,profile('hq',{active:false}),profile('hq',{active:undefined}),profile('hq',{user_id:'other'}),profile('pending'),profile('superadmin')])test('fail closed for invalid/inactive profile '+JSON.stringify(bad),()=>assert.throws(()=>routeFor('boss','u',bad,stores)));
test('missing membership, missing binding, invalid entry denied',()=>{
 assert.throws(()=>routeFor('boss','u',profile('partner'),[]),/No active stores/);
 assert.throws(()=>routeFor('staff','u',profile('store',{store_id:null}),stores),/No active stores/);
 assert.throws(()=>routeFor('https://evil.invalid','u',profile('hq')),/Choose/);
});
const session={access_token:'fake',refresh_token:'fake-refresh',user:{id:'u',user_metadata:{role:'admin'}}};
function adapter(overrides={}){return {authenticate:async()=>session,verifyUser:async()=>({id:'u'}),profile:async()=>profile('store'),stores:async()=>stores,commit(){},...overrides};}
test('user metadata cannot override live profile',async()=>{
 let commits=0;const gate=createGate(adapter({commit(){commits++;}}));
 await assert.rejects(gate.signIn('boss',{}),/Staff Login/);assert.equal(commits,0);
});
test('verify user mismatch prevents commit',async()=>{
 let commits=0;const gate=createGate(adapter({verifyUser:async()=>({id:'other'}),commit(){commits++;}}));
 await assert.rejects(gate.signIn('staff',{}),/verify/);assert.equal(commits,0);
});
test('duplicate submit suppressed and cancellation blocks stale successful sign-in',async()=>{
 let finish,calls=0,commits=0;const gate=createGate(adapter({authenticate(){calls++;return new Promise(resolve=>finish=resolve)},commit(){commits++;}}));
 const first=gate.signIn('staff',{});assert.equal(await gate.signIn('staff',{}),null);assert.equal(calls,1);
 gate.cancel();finish(session);await assert.rejects(first,{name:'AbortError'});assert.equal(commits,0);assert.equal(gate.busy,false);
});
test('late failure after back is cancelled rather than shown on next screen',async()=>{
 let reject;const gate=createGate(adapter({authenticate:()=>new Promise((_,r)=>reject=r)}));
 const first=gate.signIn('staff',{});gate.cancel();reject(Error('Old request failed'));await assert.rejects(first,{name:'AbortError'});
});
test('successful sign-in commits only after verification, profile and membership',async()=>{
 const order=[];const gate=createGate(adapter({authenticate:async()=>{order.push('auth');return session},verifyUser:async()=>{order.push('verify');return {id:'u'}},profile:async()=>{order.push('profile');return profile('partner')},stores:async()=>{order.push('stores');return stores},commit(s,r){order.push('commit');assert.equal(r.workspace,'store');assert.equal(s,session)}}));
 await gate.signIn('boss',{});assert.deepEqual(order,['auth','verify','profile','stores','commit']);
});
