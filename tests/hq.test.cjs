const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM,VirtualConsole}=require('jsdom');
const USER='11111111-1111-4111-8111-111111111111', STORE='22222222-2222-4222-8222-222222222222', TICKET='33333333-3333-4333-8333-333333333333';
const session={user:{id:USER},access_token:'test-access',refresh_token:'test-refresh'};
const base={id:TICKET,ticket_no:1,store_id:STORE,created_by:USER,title:'Repair back door',description:'Door needs attention',category:'Maintenance',priority:'normal',status:'new',created_at:'2026-10-05T01:00:00Z',updated_at:'2026-10-05T01:00:00Z',assigned_to:null};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(options={}){
 const state={tickets:[{...base}],role:'hq',refresh:0,denied:false,uploadFail:false,creates:0,comments:0,detailDelay:0,reopen:'pending',refreshStatus:200,patchConflict:false,patchDelay:0,...options}, errors=[];
 const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM(fs.readFileSync('android/app/src/main/assets/index.html','utf8'),{url:'https://hanokops.local',runScripts:'dangerously',virtualConsole:vc,beforeParse(w){
  w.localStorage.setItem('hanokops_session',JSON.stringify(session));w.URL.createObjectURL=()=> 'blob:test';w.URL.revokeObjectURL=()=>{};
  w.fetch=async(url,opts={})=>{
   const method=opts.method||'GET',data=typeof opts.body==='string'?JSON.parse(opts.body):{};let body=[],status=200;
   if(url.includes('/auth/v1/token?')){state.refresh++;await delay(15);status=state.refreshStatus;body=status===200?{...session,access_token:'refreshed-access'}:{message:'Temporary refresh failure'}}
   else if(url.includes('api.github.com/')){status=404;body={}}
   else if(url.includes('/api/hanok-ai')){status=503;body={error:'AI temporarily unavailable'}}
   else if(url.includes('/ops_profiles'))body=[{user_id:USER,display_name:'HQ Test',email:'test@example.invalid',role:state.role,store_id:null}];
   else if(url.includes('/ops_stores'))body=[{id:STORE,code:'HWD',name:'Hanok Woden',active:true}];
   else if(url.includes('/storage/v1/object/')){status=state.uploadFail?503:200;body={message:'Upload unavailable'}}
   else if(url.includes('/rest/v1/ops_tickets')){
    if(state.denied){status=401;body={message:'Unauthorized'}}
    else if(method==='POST'){state.creates++;state.tickets.unshift({...base,...data});body=[state.tickets[0]];await delay(10)}
    else if(method==='PATCH'){let q=new URL(url).searchParams;let t=state.tickets.find(t=>t.id===q.get('id').slice(3));assert.ok(q.has('status'));assert.ok(q.has('updated_at'));if(state.patchConflict||q.get('status')!=='eq.'+t.status||q.get('updated_at')!=='eq.'+t.updated_at){body=[]}else{Object.assign(t,data);body=[t]}await delay(state.patchDelay)}
    else if(new URL(url).searchParams.has('id'))body=state.tickets.filter(t=>t.id===new URL(url).searchParams.get('id').slice(3));
    else body=state.tickets;
   }
   else if(url.includes('/rpc/ops_review_reopen_request')){state.reopen=data.p_approve?'approved':'rejected';state.tickets.at(-1).status=data.p_approve?'in_progress':'completed';body=null}
   else if(url.includes('/ops_reopen_requests'))body=state.tickets.at(-1).status==='completed'?[{id:'request-1',reason:'Door still broken',status:state.reopen}]:[];
   else if(url.includes('/ops_ticket_comments')){if(method==='POST'){state.comments++;await delay(10)}body=[]}
   else if(url.includes('/ops_ticket_events')){await delay(state.detailDelay);body=[]}
   else if(url.includes('/ops_ticket_attachments')||url.includes('/ops_notifications'))body=[];
   else throw new Error('Unexpected external request '+url);
   return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  };
 }});
 const w=dom.window;
 for(let i=0;i<200;i++){if(w.document.querySelector('#homeCapture')||w.document.querySelector('#loginErr')?.textContent)break;await delay(2)}
 return {w,state,errors,close:()=>dom.window.close(),value:(id,value)=>{w.document.getElementById(id).value=value}};
}
test('HQ core lifecycle, validation, comments, reopen and navigation',async()=>{
 const f=await fixture();const {w,state,value}=f;
 try{
  assert.ok(w.document.querySelector('#homeCapture'));
  value('homeCapture','Keep my unfinished note');await w.refreshAll();assert.equal(w.document.getElementById('homeCapture').value,'Keep my unfinished note');
  const note='Woden "back door" waiting for Westfield tomorrow <script>alert(1)</script>';
  w.quickCapture(note);await w.previewCapture();assert.ok(w.document.querySelector('#capTitle'));w.document.querySelector('.detailTop button').click();assert.equal(w.document.getElementById('captureText').value,note);
  await w.openTicket(TICKET);await w.acceptTicket(TICKET);assert.equal(state.tickets[0].status,'accepted');
  await w.openTicket(TICKET);await w.startTicket(TICKET);assert.equal(state.tickets[0].status,'in_progress');
  w.waitingForm(TICKET);await w.saveWaiting(TICKET);assert.equal(state.tickets[0].status,'in_progress');value('followAt','2026-10-06T12:00');value('waitNote','Supplier ETA');await w.saveWaiting(TICKET);assert.equal(state.tickets[0].status,'waiting');
  await w.openTicket(TICKET);w.completeForm(TICKET);await w.completeTicket(TICKET);assert.equal(state.tickets[0].status,'waiting');value('resolution','Door hinge replaced');await w.completeTicket(TICKET);assert.equal(state.tickets[0].status,'completed');
  await w.openTicket(TICKET);await w.reviewReopen('request-1',true,TICKET);assert.equal(state.reopen,'approved');assert.equal(state.tickets[0].status,'in_progress');
  value('commentBody','HQ update');await Promise.all([w.addComment(TICKET),w.addComment(TICKET)]);assert.equal(state.comments,1);
  state.detailDelay=30;const pending=w.openTicket(TICKET);w.closeDetail();await pending;assert.equal(w.document.querySelector('#detail').innerHTML,'');
  w.newTicket();assert.equal(w.handleAndroidBack(),true);w.go('tickets');assert.equal(w.handleAndroidBack(),true);assert.ok(w.document.querySelector('#homeCapture'));
  assert.deepEqual(f.errors,[]);
 }finally{f.close()}
});
test('HQ attachment failure and repeated submits preserve one created ticket',async()=>{
 const f=await fixture();const {w,state,value}=f;
 try{state.uploadFail=true;w.newTicket();value('newTitle','New issue with photo');Object.defineProperty(w.document.getElementById('newFile'),'files',{value:[new w.File(['image'],'test.png',{type:'image/png'})]});await Promise.all([w.createTicket(),w.createTicket()]);assert.equal(state.creates,1);assert.match(w.document.getElementById('toast').textContent,/Ticket saved/);state.uploadFail=false;await w.createTicket();assert.equal(state.creates,1);assert.equal(w.document.querySelector('#detail').innerHTML,'');assert.deepEqual(f.errors,[])}finally{f.close()}
});
test('HQ concurrent refresh is single-flight, bounded and clears signed-out private UI',async()=>{
 const f=await fixture();const {w,state}=f;
 try{w.newTicket();state.denied=true;await Promise.all([w.api('/rest/v1/ops_tickets').catch(()=>{}),w.api('/rest/v1/ops_tickets').catch(()=>{})]);assert.equal(state.refresh,1);assert.ok(w.document.querySelector('#email'));assert.equal(w.document.querySelector('#detail').innerHTML,'');assert.equal(w.eval('notifications.length+projects.length+people.length'),0);assert.deepEqual(f.errors,[])}finally{f.close()}
});
test('HQ refuses store accounts before loading operations',async()=>{
 const f=await fixture({role:'store'});try{assert.match(f.w.document.querySelector('#loginErr').textContent,/Store accounts/);assert.equal(f.w.document.querySelector('#homeCapture'),null);assert.deepEqual(f.errors,[])}finally{f.close()}
});
test('HQ updater targets current repository and defers silent updates over a draft',async()=>{
 const f=await fixture();try{f.w.newTicket();f.w.fetch=async(url)=>{assert.match(url,/397024611\/hanok-ops/);return new Response(JSON.stringify({tag_name:'v99.0.0',assets:[{name:'Baogao-Laoban-Release.apk',browser_download_url:'https://github.com/397024611/hanok-ops/releases/download/v99.0.0/Baogao-Laoban-Release.apk'}]}))};await f.w.checkForAppUpdate(true);assert.ok(f.w.document.getElementById('newTitle'))}finally{f.close()}
});

test('HQ refresh outage preserves valid session and current screen',async()=>{
 const f=await fixture();try{f.state.denied=true;f.state.refreshStatus=503;await assert.rejects(f.w.api('/rest/v1/ops_tickets'),/refresh unavailable/);assert.ok(f.w.eval('session'));assert.ok(f.w.document.querySelector('#homeCapture'));assert.equal(f.state.refresh,1)}finally{f.close()}
});
test('HQ optimistic writes reject concurrent updates and do not reopen dismissed UI',async()=>{
 const f=await fixture();try{await f.w.openTicket(TICKET);f.state.patchConflict=true;await f.w.acceptTicket(TICKET);assert.equal(f.state.tickets[0].status,'new');assert.match(f.w.document.getElementById('toast').textContent,/Another user/);f.state.patchConflict=false;f.state.patchDelay=30;const pending=f.w.acceptTicket(TICKET);f.w.closeDetail();await pending;assert.equal(f.w.document.querySelector('#detail').innerHTML,'');assert.equal(f.state.tickets[0].status,'accepted')}finally{f.close()}
});
test('HQ stale open form keeps original version even after background refresh',async()=>{
 const f=await fixture();try{await f.w.openTicket(TICKET);f.w.waitingForm(TICKET);f.value('followAt','2026-10-06T12:00');f.state.tickets[0].status='waiting';f.state.tickets[0].waiting_reason='Updated by colleague';f.state.tickets[0].updated_at='2026-10-05T02:00:00Z';await f.w.refreshAll();await f.w.saveWaiting(TICKET);assert.equal(f.state.tickets[0].waiting_reason,'Updated by colleague');assert.match(f.w.document.getElementById('toast').textContent,/Another user/)}finally{f.close()}
});
test('HQ delayed response body cannot restore private caches after logout',async()=>{
 const f=await fixture();try{let release;f.w.fetch=async()=>({ok:true,status:200,text:()=>new Promise(r=>{release=r})});const loading=f.w.loadTickets(true);await delay(1);f.w.logout();release(JSON.stringify([base]));await loading;assert.equal(f.w.eval('session'),null);assert.equal(f.w.eval('tickets.length'),0);assert.equal(f.w.document.querySelector('#detail').innerHTML,'')}finally{f.close()}
});
test('HQ old failed refresh cannot sign out a newly signed-in account',async()=>{
 const f=await fixture();try{let release;f.w.fetch=async(url)=>url.includes('/auth/v1/')?new Promise(r=>{release=r}):new Response('{"message":"Expired"}',{status:401});const request=f.w.api('/rest/v1/ops_tickets').catch(e=>e.message);await delay(1);f.w.eval('sessionEpoch++;session={user:{id:"new-user"},access_token:"new-access",refresh_token:"new-refresh"}');release(new Response('{}',{status:400}));await request;assert.equal(f.w.eval('session.user.id'),'new-user')}finally{f.close()}
});
test('HQ upload cannot write metadata or retry under a changed account',async()=>{
 const f=await fixture();try{let release,writes=0;f.w.fetch=async(url)=>{if(url.includes('/storage/'))return new Promise(r=>{release=r});writes++;return new Response('[]')};const request=f.w.uploadAttachment(TICKET,new f.w.File(['test'],'test.png',{type:'image/png'})).catch(e=>e.message);await delay(1);f.w.eval('sessionEpoch++;session={user:{id:"new-user"},access_token:"new-access",refresh_token:"new-refresh"}');release(new Response('{}',{status:200}));assert.match(await request,/Session changed/);assert.equal(writes,0);assert.equal(f.w.eval('session.user.id'),'new-user')}finally{f.close()}
});
test('HQ lost storage response retries stable object with upsert and one metadata insert',async()=>{
 const f=await fixture();try{let uploads=0,metadata=0,path;f.w.fetch=async(url,opts)=>{if(url.includes('/storage/')){assert.equal(opts.headers['x-upsert'],'true');if(path)assert.equal(url,path);path=url;if(++uploads===1)throw new Error('Response lost after commit');return new Response('{}')}if(url.includes('/ops_ticket_attachments'))metadata++;return new Response('[]')};f.w.newTicket();const file=new f.w.File(['image'],'test.png',{type:'image/png'}),draft=f.w.eval('ticketDraft');await assert.rejects(f.w.uploadAttachment(TICKET,file,draft));await f.w.uploadAttachment(TICKET,file,draft);assert.equal(uploads,2);assert.equal(metadata,1)}finally{f.close()}
});
test('HQ nested media Back dismisses preview before its parent ticket',async()=>{
 const f=await fixture();try{await f.w.openTicket(TICKET);const media=f.w.document.createElement('div');media.className='mediaPreview';f.w.document.querySelector('#detail').appendChild(media);assert.equal(f.w.handleAndroidBack(),true);assert.equal(f.w.document.querySelector('.mediaPreview'),null);assert.ok(f.w.document.querySelector('#detail.show'));assert.equal(f.w.handleAndroidBack(),true);assert.equal(f.w.document.querySelector('#detail.show'),null)}finally{f.close()}
});
test('HQ successful AI results render as text and a reviewed capture remains editable',async()=>{
 const f=await fixture();try{const orig=f.w.fetch;f.w.fetch=async(url,opts)=>url.includes('/api/hanok-ai')?new Response(JSON.stringify(url.endsWith('/analyze')?{result:{title:'AI suggested title',store:'Hanok Woden',category:'Maintenance',priority:'normal'}}:{answer:'<img onerror=alert(1)> Next action',brief:'<script>AI brief</script>'})):orig(url,opts);f.w.quickCapture('Woden door');await f.w.previewCapture();assert.equal(f.w.document.getElementById('capTitle').value,'AI suggested title');f.w.askHanokAi('What next?');await f.w.runAiQuery();assert.match(f.w.document.querySelector('#aiAnswerWrap').textContent,/<img/);assert.equal(f.w.document.querySelector('#aiAnswerWrap img'),null);f.w.openBrief();await f.w.loadAiBrief();assert.equal(f.w.document.querySelector('#aiBriefResult script'),null);await f.w.openTicket(TICKET);await f.w.ticketAiAssist(TICKET,'followup');assert.match(f.w.document.querySelector('#ticketAiBox').textContent,/Next action/)}finally{f.close()}
});
test('HQ interrupted attachment can resume after close and reload without a new ticket',async()=>{
 const f=await fixture();const {w,state,value}=f;try{state.uploadFail=true;w.newTicket();value('newTitle','Recover attachment');const file=new w.File(['image'],'recover.png',{type:'image/png'});Object.defineProperty(w.document.getElementById('newFile'),'files',{value:[file]});await w.createTicket();assert.equal(state.creates,1);w.closeDetail();w.render();assert.match(w.document.getElementById('app').textContent,/Submission needs finishing/);w.eval('pendingTicketDraft=null;ticketDraft=null');w.loadPendingTicketDraft();w.resumePendingTicket();assert.ok(w.document.querySelector('#resumeFile'));Object.defineProperty(w.document.getElementById('resumeFile'),'files',{value:[file]});state.uploadFail=false;await w.retryPendingTicket();assert.equal(state.creates,1);assert.equal(w.localStorage.getItem('hanokops_pending_draft:'+USER),null)}finally{f.close()}
});
test('HQ comment lost response reconciles stable ID without duplicate retry',async()=>{
 const f=await fixture();try{await f.w.openTicket(TICKET);f.value('commentBody','Comment with lost confirmation');let committed,posts=0;const original=f.w.fetch;f.w.fetch=async(url,opts)=>{if(url.includes('/ops_ticket_comments')&&opts.method==='POST'){posts++;committed=JSON.parse(opts.body);throw new Error('Network response lost')}if(url.includes('/ops_ticket_comments?id=eq.'))return new Response(JSON.stringify([{id:committed.id}]));return original(url,opts)};await f.w.addComment(TICKET);assert.equal(posts,1);assert.ok(committed.id);assert.match(f.w.document.getElementById('toast').textContent,/Comment added/)}finally{f.close()}
});
test('HQ AI repeated taps issue only one model request per action',async()=>{
 const f=await fixture();try{let calls=0;f.w.fetch=async()=>{calls++;await delay(20);return new Response('{"answer":"Ready","brief":"Brief"}')};f.w.askHanokAi('What next?');await Promise.all([f.w.runAiQuery(),f.w.runAiQuery()]);assert.equal(calls,1);f.w.openBrief();await Promise.all([f.w.loadAiBrief(),f.w.loadAiBrief()]);assert.equal(calls,2)}finally{f.close()}
});
test('HQ ticket filters, search, owner and Inbox actions use current data',async()=>{
 const f=await fixture();try{f.state.tickets.push({...base,id:'ticket-urgent',title:'Urgent supplier order',category:'Supplier / Stock',priority:'urgent',assigned_to:USER},{...base,id:'ticket-done',title:'Resolved invoice',status:'completed',category:'Finance'});await f.w.refreshAll();f.w.go('tickets');f.w.eval('filter="urgent"');f.w.render();assert.match(f.w.document.querySelector('.content').textContent,/Urgent supplier/);assert.doesNotMatch(f.w.document.querySelector('.content').textContent,/Resolved invoice/);f.w.eval('filter="completed";searchText="invoice"');f.w.render();assert.match(f.w.document.querySelector('.content').textContent,/Resolved invoice/);await f.w.openTicket(TICKET);await f.w.assignTicket(TICKET,USER);assert.equal(f.state.tickets[0].assigned_to,USER);f.w.eval('notifications=[{id:"n1",ticket_id:"'+TICKET+'",title:"New ticket",body:"Review",kind:"new_ticket",created_at:"2026-10-05T00:00:00Z",read_at:null}]');f.w.closeDetail();f.w.go('alerts');await f.w.openNotification('n1',TICKET);assert.ok(f.w.document.querySelector('#detail.show'));assert.ok(f.w.eval('notifications[0].read_at'));f.w.closeDetail();await f.w.markAllRead()}finally{f.close()}
});
test('HQ local Projects create, edit and generate linked-store ticket drafts',async()=>{
 const f=await fixture();try{f.w.newProject();f.value('pName','New store opening');f.value('pStore',STORE);f.value('pLocation','New location');f.value('pNext','Confirm lease');f.w.createProject();const id=f.w.eval('projects[0].id');assert.equal(f.w.eval('projects.length'),1);f.w.openProject(id);f.value('epNext','Arrange equipment');f.w.saveProject(id);assert.equal(f.w.eval('projects[0].next_action'),'Arrange equipment');f.w.projectToTicket(id);assert.match(f.w.document.getElementById('newTitle').value,/Arrange equipment/);f.w.closeDetail();f.w.loadLocalProjects();assert.equal(f.w.eval('projects[0].name'),'New store opening')}finally{f.close()}
});
test('HQ voice and text share feed Quick Capture without creating unreviewed tickets',async()=>{
 const f=await fixture();try{f.w.receiveVoiceCapture('Woden refrigerator repair');assert.equal(f.w.document.getElementById('captureText').value,'Woden refrigerator repair');f.w.closeDetail();f.w.receiveSharedText('Wagga supplier follow up tomorrow');await delay(100);assert.equal(f.w.document.getElementById('captureText').value,'Wagga supplier follow up tomorrow');assert.equal(f.state.creates,0)}finally{f.close()}
});
test('HQ recovery and sign-in UI validates and handles mocked service responses',async()=>{
 const f=await fixture();try{f.w.logout();f.w.fetch=async(url,opts)=>new Response(JSON.stringify(url.includes('/verify')?{access_token:'dummy-recovery-token'}:url.includes('grant_type=password')?{error_description:'Invalid login'}:{}),{status:url.includes('grant_type=password')?400:200});f.value('email','qa@example.invalid');await f.w.forgotPassword();assert.equal(f.w.document.getElementById('recoveryTools').classList.contains('hidden'),false);f.value('recoveryLink','https://tqfwbsjchespjkxliodo.supabase.co/auth/v1/verify?token=dummy&type=recovery');await f.w.verifyRecoveryLink();f.value('newPassword','test-only-password');f.value('confirmPassword','mismatch');await f.w.setRecoveredPassword();assert.match(f.w.document.getElementById('resetErr').textContent,/do not match/);f.value('confirmPassword','test-only-password');await f.w.setRecoveredPassword();assert.match(f.w.document.getElementById('loginErr').textContent,/Password updated/);f.value('email','qa@example.invalid');f.value('password','test-only-password');await f.w.signIn();assert.match(f.w.document.getElementById('loginErr').textContent,/Invalid login/)}finally{f.close()}
});
test('HQ missing original attachment has a confirmed escape and Quick Capture preserves pending ID',async()=>{
 const f=await fixture();try{f.state.uploadFail=true;f.w.newTicket();f.value('newTitle','File no longer available');Object.defineProperty(f.w.document.getElementById('newFile'),'files',{value:[new f.w.File(['image'],'missing.png',{type:'image/png'})]});await f.w.createTicket();const id=f.w.eval('pendingTicketDraft.id');f.w.closeDetail();f.w.quickCapture('Do not overwrite original');assert.equal(f.w.eval('pendingTicketDraft.id'),id);assert.equal(f.w.document.querySelector('#captureText'),null);f.w.confirm=()=>false;f.w.stopPendingTicket();assert.equal(f.w.eval('pendingTicketDraft.id'),id);f.w.confirm=()=>true;f.w.stopPendingTicket();assert.equal(f.w.eval('pendingTicketDraft'),null);assert.equal(f.state.creates,1);f.w.newTicket();assert.ok(f.w.document.getElementById('newTitle'))}finally{f.close()}
});
test('HQ durable upload path and binary-complete state are saved before metadata request',async()=>{
 const f=await fixture();try{const original=f.w.fetch;let savedDuringUpload,savedDuringMetadata;f.w.fetch=async(url,opts)=>{if(url.includes('/storage/'))savedDuringUpload=JSON.parse(f.w.localStorage.getItem('hanokops_pending_draft:'+USER));if(url.includes('/ops_ticket_attachments'))savedDuringMetadata=JSON.parse(f.w.localStorage.getItem('hanokops_pending_draft:'+USER));return original(url,opts)};f.w.newTicket();f.value('newTitle','Durable attachment');Object.defineProperty(f.w.document.getElementById('newFile'),'files',{value:[new f.w.File(['image'],'durable.png',{type:'image/png'})]});await f.w.createTicket();assert.ok(savedDuringUpload.uploadPath);assert.equal(savedDuringMetadata.uploadPath,savedDuringUpload.uploadPath);assert.equal(savedDuringMetadata.uploaded,true)}finally{f.close()}
});
