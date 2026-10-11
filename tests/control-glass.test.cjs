'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{JSDOM}=require('jsdom');
const css=fs.readFileSync('mobile/glass.css','utf8');
function workspace(file){
 const source=fs.readFileSync(file,'utf8').replace('<link rel="stylesheet" href="glass.css">','<style>'+css+'</style>');
 const dom=new JSDOM(source,{url:'https://workspace.test/',runScripts:'dangerously',pretendToBeVisual:true,beforeParse(w){w.AbortController=AbortController;w.AbortSignal=AbortSignal;w.fetch=async()=>{throw Error('Unexpected external request')};w.CSS={escape:x=>x};w.scrollTo=()=>{}}});
 return {w:dom.window,d:dom.window.document,close:()=>dom.window.close()};
}
function store(){const a=workspace('store-portal/index.html');a.w.eval(`session={user:{id:'u'},access_token:'fake',refresh_token:'fake'};profile={role:'store',display_name:'Staff'};store={id:'s',name:'Assigned store',code:'ONE'};assignedStores=[store];tickets=[{id:'t1',title:'Urgent cool room',priority:'urgent',status:'new',ticket_no:1,created_at:'2026-10-11T00:00:00Z',category:'Maintenance'},{id:'t2',title:'POS connection',priority:'normal',status:'waiting',ticket_no:2,created_at:'2026-10-11T00:00:00Z',category:'IT / POS'},{id:'t3',title:'Completed repair',priority:'normal',status:'completed',ticket_no:3,created_at:'2026-10-11T00:00:00Z'}];render();`);return a;}
test('flat canvas and opaque content keep material on controls only',()=>{
 for(const file of ['mobile/entry.css','mobile/glass.css'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/url\(|glass-background|caustic/);
 assert.match(css,/html, body\s*\{ background: var\(--canvas\)/);
 for(const selector of ['.rb-sheet','.meta','.comment']){const rule=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(m=>m[1].trim()===selector)?.[2];assert.ok(rule,selector);assert.match(rule,/background: transparent/);assert.doesNotMatch(rule,/blur\(\d/)}
 assert.match(css,/--control-blur: none/);assert.match(css,/\.reduce-glass\s*\{[^}]*--control-fill: #fff/);
});
test('staff floating navigation is self-contained and below modal overlay',()=>{
 const a=store();try{const nav=a.d.querySelector('nav'),style=a.w.getComputedStyle(nav),overlay=a.w.getComputedStyle(a.d.querySelector('#overlay'));
 assert.equal(style.position,'fixed');assert.equal(style.display,'grid');assert.ok(Number(style.zIndex)<Number(overlay.zIndex));assert.equal(nav.querySelectorAll('button').length,2);assert.equal(nav.querySelector('[aria-current=page]').textContent,'Tickets');
 assert.equal(a.w.getComputedStyle(nav.querySelector('button')).minHeight,'60px');
 }finally{a.close()}
});
test('staff search composes with status and retains typing/focus across refresh',()=>{
 const a=store();try{const input=a.d.querySelector('#storeTicketSearch');input.value='POS';input.focus();input.setSelectionRange(2,2);a.w.render();assert.equal(a.d.querySelector('#storeTicketSearch').value,'POS');assert.equal(a.d.activeElement.id,'storeTicketSearch');assert.equal(a.d.activeElement.selectionStart,2);a.w.applyStoreSearch();assert.equal(a.d.querySelectorAll('[data-ticket]').length,1);assert.equal(a.d.querySelector('[data-ticket]').dataset.ticket,'t2');a.w.eval(`filter='completed';render()`);assert.equal(a.d.querySelectorAll('[data-ticket]').length,0);a.w.clearStoreSearch();assert.equal(a.d.querySelector('#storeTicketSearch').value,'');assert.equal(a.d.querySelector('[data-ticket]').dataset.ticket,'t3');}finally{a.close()}
});
test('store scope reset clears search state and unsubmitted search text',()=>{
 const a=store();try{a.d.querySelector('#storeTicketSearch').value='Old store detail';a.w.applyStoreSearch();a.w.clearStoreContext();assert.equal(a.w.eval('ticketSearchText'),'');assert.equal(a.d.querySelector('#storeTicketSearch').value,'');}finally{a.close()}
});
test('partner uses the same search but cannot report or change status',()=>{
 const a=store();try{a.w.eval(`profile.role='partner';render()`);assert.equal(a.d.querySelector('.plus'),null);assert.ok(a.d.querySelector('#assignedStore'));assert.ok(a.d.querySelector('#storeTicketSearch'));assert.equal(a.d.querySelector('.actions'),null);}finally{a.close()}
});
test('search results escape user-controlled text and status remains explicit on urgent cards',()=>{
 const a=store();try{a.d.querySelector('#storeTicketSearch').value='<img src=x onerror=alert(1)>';a.w.applyStoreSearch();assert.equal(a.d.querySelector('.rb-search-result img'),null);assert.match(a.d.querySelector('.rb-search-result').textContent,/<img/);a.w.clearStoreSearch();const card=a.d.querySelector('[data-ticket=t1]');assert.match(card.textContent,/Urgent/);assert.match(card.textContent,/New/);}finally{a.close()}
});
test('HQ exposes every original ticket view and all five work areas',()=>{
 const a=workspace('android/app/src/main/assets/index.html');try{a.w.eval(`session={user:{id:'u'},access_token:'fake',refresh_token:'fake'};profile={user_id:'u',role:'admin',active:true,display_name:'Admin'};stores=[];tickets=[];notifications=[];page='tickets';render()`);assert.deepEqual([...a.d.querySelectorAll('#ticketView option')].map(x=>x.value),['active','mine','today','overdue','urgent','waiting','completed']);assert.equal(a.d.querySelectorAll('.rb-filters button').length,3);assert.equal(a.d.querySelectorAll('nav button').length,5);const select=a.d.querySelector('#ticketView');select.value='mine';select.dispatchEvent(new a.w.Event('change',{bubbles:true}));assert.equal(a.w.eval('filter'),'mine');assert.equal(a.d.querySelector('#ticketView').value,'mine');}finally{a.close()}
});
test('standalone shared-login headings and labels override legacy white text',()=>{
 const a=workspace('store-portal/index.html');try{assert.ok(a.d.querySelector('.loginCard h2'));assert.match(css,/\.login \.brand, \.loginCard h2, \.loginCard \.field\s*\{ color: var\(--text\)/);}finally{a.close()}
});
test('release metadata remains aligned without changing Android application identity',()=>{
 const gradle=fs.readFileSync('android/app/build.gradle','utf8');assert.match(gradle,/applicationId 'com\.hanokgroup\.ops'/);assert.match(gradle,/versionCode 17/);assert.match(gradle,/versionName '0\.10\.1'/);assert.match(fs.readFileSync('.github/workflows/release-baogao-laoban.yml','utf8'),/versionCode='17' versionName='0\.10\.1'/);
});

test('waiting tickets retain distinct overdue and follow-up dates',()=>{
 const a=store();try{a.w.eval(`tickets[1].due_at='2020-01-01T00:00:00Z';tickets[1].follow_up_at='2030-01-01T00:00:00Z';render()`);const card=a.d.querySelector('[data-ticket=t2]');assert.match(card.querySelector('.ticket-date.overdue').textContent,/Overdue/);assert.match(card.querySelector('.ticket-reference').textContent,/Follow-up/);assert.doesNotMatch(card.querySelector('.ticket-date.overdue').textContent,/2030/);}finally{a.close()}
});

test('standalone store search is a self-contained two-column control',()=>{
 const a=store();try{const form=a.d.querySelector('.rb-store-search'),style=a.w.getComputedStyle(form);assert.equal(style.display,'grid');assert.equal(style.gridTemplateColumns,'minmax(0,1fr) auto');assert.equal(style.gap,'8px');}finally{a.close()}
});
