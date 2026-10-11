'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{JSDOM}=require('jsdom');
const hqPath='android/app/src/main/assets/index.html',storePath='store-portal/index.html';
function workspace(file){const html=fs.readFileSync(file,'utf8'),dom=new JSDOM(html,{url:'https://workspace.test/',runScripts:'dangerously',beforeParse(w){w.AbortController=AbortController;w.AbortSignal=AbortSignal;w.fetch=async()=>{throw Error('Unexpected external request')}}}),w=dom.window;return{w,d:w.document,close:()=>w.close()}}
test('approved glass assets are packaged consistently for existing web and Android workspaces',()=>{
 for(const dir of ['store-portal','android/app/src/main/assets']){
  assert.equal(fs.readFileSync(dir+'/glass.css','utf8'),fs.readFileSync('mobile/glass.css','utf8'));
  assert.deepEqual(fs.readFileSync(dir+'/assets/glass-background.png'),fs.readFileSync('mobile/assets/glass-background.png'));
  for(const file of fs.readdirSync('mobile/assets/icons'))assert.deepEqual(fs.readFileSync(dir+'/assets/icons/'+file),fs.readFileSync('mobile/assets/icons/'+file));
 }
 const css=fs.readFileSync('mobile/glass.css','utf8');assert.match(css,/prefers-reduced-transparency/);assert.match(css,/prefers-reduced-motion/);assert.match(css,/@supports not\(backdrop-filter/);
});
test('real entry keeps all sign-in fields and excludes prototype fake roles and sample accounts',()=>{
 const html=fs.readFileSync('mobile/index.html','utf8');
 for(const id of ['choose','login','login-title','methods','form','email','password','store','error','submit','back'])assert.ok(html.includes('id="'+id+'"'));
 for(const text of ['Preview role','Enter preview','Sample data only','initial:Ticket','Create sample ticket'])assert.ok(!html.includes(text));
});
test('staff glass ticket list preserves escaped data and partner restrictions; profile is dismissible',()=>{
 const a=workspace(storePath);try{
 a.w.eval(`session={user:{id:'u'},access_token:'fake',refresh_token:'fake'};profile={role:'partner',display_name:'<img src=x onerror=alert(1)>'};store={id:'s',name:'Assigned store',code:'ONE'};assignedStores=[store];tickets=[{id:'t1',title:'Urgent item',priority:'urgent',status:'new',ticket_no:1,created_at:new Date().toISOString(),category:'Maintenance'},{id:'t2',title:'<script>bad</script>',priority:'normal',status:'waiting',ticket_no:2,created_at:new Date().toISOString()}];render();`);
 assert.equal(a.d.querySelector('.plus'),null);assert.equal(a.d.querySelectorAll('[data-ticket]').length,2);assert.match(a.d.querySelector('.rb-group').textContent,/NEEDS ATTENTION/);assert.match(a.d.querySelector('[data-ticket=t2]').textContent,/<script>bad<\/script>/);assert.equal(a.d.querySelector('[data-ticket=t2] script'),null);
 a.w.workspaceProfile();assert.equal(a.d.querySelector('[role=dialog]').getAttribute('aria-modal'),'true');assert.match(a.d.querySelector('.detailCard h1').textContent,/<img src=x/);assert.equal(a.d.querySelector('.detailCard img'),null);
 a.w.toggleGlassPreference();assert.equal(a.w.localStorage.getItem('reportboss_reduce_transparency'),'true');assert.equal(a.d.querySelector('[data-glass-toggle]').getAttribute('aria-pressed'),'true');a.w.closeOverlay();assert.equal(a.d.querySelector('[role=dialog]'),null);
 a.w.eval(`profile.role='store';render()`);assert.ok(a.d.querySelector('.plus'));assert.equal(a.d.querySelector('#assignedStore'),null);
 }finally{a.close()}
});
test('HQ glass navigation retains all five work areas and account controls',()=>{
 const a=workspace(hqPath);try{a.w.eval(`session={user:{id:'u'},access_token:'fake',refresh_token:'fake'};profile={user_id:'u',role:'admin',active:true,display_name:'Admin'};stores=[];tickets=[];notifications=[];page='tickets';render();`);assert.equal(a.d.querySelectorAll('nav.nav button').length,5);assert.equal(a.d.querySelector('.rb-title-row h1').textContent,'Tickets');assert.ok(a.d.querySelector('button[onclick="newTicket()"]'));a.w.eval(`page='profile';render()`);assert.ok(a.d.querySelector('#accountManagementButton'));assert.match(a.d.body.textContent,/Send local test notification/);assert.ok(a.d.querySelector('[data-glass-toggle]'));}finally{a.close()}
});
