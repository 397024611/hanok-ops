const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
const html=fs.readFileSync('mobile/index.html','utf8');
function setup(options={}){
 const dom=new JSDOM(html,{url:'https://hanokops.local/index.html',runScripts:'outside-only'}),w=dom.window;
 w.AbortController=AbortController;w.AbortSignal=AbortSignal;
 w.ReportBossConfig={url:'https://backend.example.invalid',key:'sb_publishable_fake',stores:[{code:'ONE',name:'Fictional store'}]};
 if(options.reduceGlass)w.localStorage.setItem('reportboss_reduce_transparency','true');
 w.fetch=async()=>{throw Error('Unexpected network')};
 w.eval(fs.readFileSync('mobile/access.js','utf8'));w.eval(fs.readFileSync('mobile/entry.js','utf8'));
 return {dom,w,$:id=>w.document.getElementById(id),click:q=>w.document.querySelector(q).click()};
}
test('bilingual selector, private individual default, shared password reset, return navigation',()=>{
 const {dom,w,$,click}=setup();
 assert.match($('choose').textContent,/老板登录/);assert.match($('choose').textContent,/Staff Login/);
 click('[data-entry=staff]');assert.equal($('choose').hidden,true);assert.equal($('methods').hidden,false);assert.equal($('email-wrap').hidden,false);
 $('password').value='fictional';click('[data-method=shared]');assert.equal($('password').value,'');assert.equal($('store-wrap').hidden,false);assert.equal($('email').required,false);
 click('#back');assert.equal($('choose').hidden,false);assert.equal(w.location.hash,'');
 click('[data-entry=boss]');assert.equal($('methods').hidden,true);assert.equal($('email-wrap').hidden,false);
 w.history.replaceState(null,'','#staff');w.dispatchEvent(new w.PopStateEvent('popstate'));assert.match($('login-title').textContent,/Staff/);
 w.history.replaceState(null,'','#evil');w.dispatchEvent(new w.PopStateEvent('popstate'));assert.equal($('choose').hidden,false);
 dom.window.close();
});
test('real page cancels duplicate and stale login when changing entry',async()=>{
 const {dom,w,$,click}=setup();let finish,count=0;
 w.fetch=()=>{count++;return new Promise(resolve=>finish=resolve)};
 click('[data-entry=staff]');$('email').value='a@example.invalid';$('password').value='fictional';
 const submit=()=> $('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));submit();submit();
 assert.equal(count,1);assert.equal($('password').value,'');click('#back');click('[data-entry=boss]');
 finish({ok:true,json:async()=>({user:{id:'u'},access_token:'fake',refresh_token:'fake'})});await new Promise(r=>setImmediate(r));
 assert.equal(w.localStorage.length,0);assert.equal($('error').textContent,'');assert.match($('login-title').textContent,/Boss/);dom.window.close();
});
test('real page uses live profile and refuses staff through Boss; never saves password/session',async()=>{
 const {dom,w,$,click}=setup();const urls=[];
 w.fetch=async(url,options)=>{urls.push(url);const body=url.includes('/token?')?{user:{id:'u',user_metadata:{role:'admin'}},access_token:'fake',refresh_token:'fake'}:url.endsWith('/user')?{id:'u'}:url.includes('/ops_profiles?')?[{user_id:'u',role:'store',active:true,store_id:'s'}]:[{id:'s',active:true}];return {ok:true,json:async()=>body};};
 click('[data-entry=boss]');$('email').value='a@example.invalid';$('password').value='fictional';$('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
 await new Promise(r=>setImmediate(r));assert.match($('error').textContent,/Staff Login/);assert.equal(w.localStorage.length,0);assert.ok(urls.some(x=>x.endsWith('/auth/v1/user')));assert.equal($('submit').disabled,false);dom.window.close();
});

test('selector restores saved reduced-transparency preference',()=>{const {dom,w}=setup({reduceGlass:true});assert.ok(w.document.documentElement.classList.contains('reduce-glass'));dom.window.close();});
