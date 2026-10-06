#!/usr/bin/env python3
"""Mock-only Chromium regression tests. No real Supabase/AI calls are made."""
import asyncio,json,threading,http.server,functools,pathlib
from playwright.async_api import async_playwright
ROOT=pathlib.Path(__file__).resolve().parents[1]
USER='11111111-1111-4111-8111-111111111111'; STORE='22222222-2222-4222-8222-222222222222'; TICKET='33333333-3333-4333-8333-333333333333'
SESSION={'user':{'id':USER},'access_token':'test-access','refresh_token':'test-refresh'}
PROFILE={'user_id':USER,'display_name':'HQ Test','email':'test@example.invalid','role':'hq','store_id':None}
BASE_TICKET={'id':TICKET,'ticket_no':1,'store_id':STORE,'created_by':USER,'title':'Repair back door','description':'Door needs attention','category':'Maintenance','priority':'normal','status':'new','created_at':'2026-10-05T01:00:00Z','updated_at':'2026-10-05T01:00:00Z','assigned_to':None}
class Quiet(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
async def main():
 server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(ROOT)))
 threading.Thread(target=server.serve_forever,daemon=True).start()
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
  context=await browser.new_context(viewport={'width':412,'height':915})
  page=await context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  state={'tickets':[BASE_TICKET.copy()],'role':'hq','refresh':0,'denied':False,'upload_fail':False,'creates':0,'comments':0,'delay_detail':False,'reopen':'pending','patches':0}
  async def route(r):
   url=r.request.url;method=r.request.method
   if url.startswith('http://127.0.0.1:'):return await r.continue_()
   data=r.request.post_data_json if method in ('POST','PATCH') and r.request.headers.get('content-type','').startswith('application/json') else {}
   code=200;body=[]
   if '/auth/v1/token?' in url:state['refresh']+=1;await asyncio.sleep(.05);body=SESSION
   elif 'api.github.com/' in url:code=404;body={}
   elif '/api/hanok-ai' in url:code=503;body={'error':'AI temporarily unavailable'}
   elif '/rest/v1/ops_profiles' in url:body=[{**PROFILE,'role':state['role']}]
   elif '/rest/v1/ops_stores' in url:body=[{'id':STORE,'code':'HWD','name':'Hanok Woden','active':True}]
   elif '/storage/v1/object/' in url:code=503 if state['upload_fail'] else 200;body={'message':'Upload unavailable'} if code==503 else {}
   elif '/rest/v1/ops_tickets' in url:
    if state['denied']:code=401;body={'message':'Unauthorized'}
    elif method=='POST':state['creates']+=1;state['tickets'].insert(0,{**BASE_TICKET,**data});body=[state['tickets'][0]]
    elif method=='PATCH':
     ident=url.split('id=eq.')[1].split('&')[0];t=next(t for t in state['tickets'] if t['id']==ident);t.update(data);state['patches']+=1;body=[t]
    elif 'id=eq.' in url:body=[t for t in state['tickets'] if t['id']==url.split('id=eq.')[1].split('&')[0]]
    else:body=state['tickets']
   elif '/rpc/ops_review_reopen_request' in url:state['reopen']='approved' if data['p_approve'] else 'rejected';state['tickets'][-1]['status']='in_progress' if data['p_approve'] else 'completed';body=None
   elif '/ops_reopen_requests' in url:body=[{'id':'request-1','reason':'Door still broken','status':state['reopen']}] if state['tickets'][-1]['status']=='completed' else []
   elif '/ops_ticket_comments' in url:
    if method=='POST':state['comments']+=1;await asyncio.sleep(.05)
    body=[]
   elif '/ops_ticket_events' in url:
    if state['delay_detail']:await asyncio.sleep(.2)
    body=[]
   elif '/ops_ticket_attachments' in url:body=[]
   elif '/ops_notifications' in url:body=[]
   else:raise AssertionError('Unexpected external request: '+url)
   await r.fulfill(status=code,content_type='application/json',body=json.dumps(body))
  await page.route('**/*',route)
  await page.add_init_script('localStorage.setItem("hanokops_session",'+json.dumps(json.dumps(SESSION))+')')
  await page.goto(f'http://127.0.0.1:{server.server_port}/android/app/src/main/assets/index.html')
  await page.wait_for_selector('#homeCapture');await page.wait_for_function('!document.querySelector("#loading.show")')
  await page.fill('#homeCapture','Keep my unfinished note');await page.evaluate('refreshAll()');assert await page.input_value('#homeCapture')=='Keep my unfinished note'
  print('PASS: background sync preserves text draft')
  note='Woden "back door" waiting for Westfield tomorrow <script>alert(1)</script>'
  await page.evaluate('(text)=>quickCapture(text)',note);await page.click('text=Turn into Ticket');await page.wait_for_selector('#capTitle');await page.click('.detailTop button:first-child');assert await page.input_value('#captureText')==note
  print('PASS: AI unavailable fallback and quote-safe capture navigation')
  await page.evaluate('closeDetail();openTicket("'+TICKET+'")');await page.wait_for_selector('.actions');await page.click('text=✓ Accept');await page.wait_for_function('!document.querySelector("#loading.show")');assert state['tickets'][-1]['status']=='accepted'
  await page.evaluate('openTicket("'+TICKET+'")');await page.click('text=▶ Start Work');await page.wait_for_function('!document.querySelector("#loading.show")');assert state['tickets'][-1]['status']=='in_progress'
  await page.click('text=◷ Waiting');await page.click('text=Save Follow-up');assert state['tickets'][-1]['status']=='in_progress'
  await page.fill('#followAt','2026-10-06T12:00');await page.fill('#waitNote','Supplier ETA');await page.click('text=Save Follow-up');await page.wait_for_function('!document.querySelector("#loading.show")');assert state['tickets'][-1]['status']=='waiting'
  await page.evaluate('openTicket("'+TICKET+'")');await page.click('.actions .complete');await page.click('button.primary');assert state['tickets'][-1]['status']=='waiting'
  await page.fill('#resolution','Door hinge replaced');await page.click('button.primary');await page.wait_for_function('!document.querySelector("#loading.show")');assert state['tickets'][-1]['status']=='completed'
  await page.evaluate('openTicket("'+TICKET+'")');await page.click('text=Approve & Reopen');await page.wait_for_function('!document.querySelector("#loading.show")');assert state['reopen']=='approved' and state['tickets'][-1]['status']=='in_progress'
  print('PASS: New → Accepted → In Progress → Waiting → Completed → reopened; required fields')
  await page.fill('#commentBody','HQ follow-up');await page.evaluate('Promise.all([addComment("'+TICKET+'"),addComment("'+TICKET+'")])');assert state['comments']==1
  print('PASS: duplicate comment suppressed')
  state['delay_detail']=True;await page.evaluate('openTicket("'+TICKET+'");closeDetail()');await page.wait_for_timeout(300);assert await page.locator('#detail').inner_html()==''
  print('PASS: late ticket detail cannot resurrect dismissed screen')
  state['delay_detail']=False
  state['upload_fail']=True;await page.evaluate('newTicket()');await page.fill('#newTitle','New issue with photo');await page.set_input_files('#newFile',{'name':'image.png','mimeType':'image/png','buffer':b'test-image'});await page.evaluate('Promise.all([createTicket(),createTicket()])');assert state['creates']==1
  state['upload_fail']=False;await page.evaluate('createTicket()');assert state['creates']==1;assert not await page.locator('#detail').evaluate('(e)=>e.classList.contains("show")')
  print('PASS: ticket creation and attachment retries are idempotent')
  await page.evaluate('newTicket()');state['denied']=True;before=state['refresh'];await page.evaluate('Promise.all([api("/rest/v1/ops_tickets").catch(e=>e.message),api("/rest/v1/ops_tickets").catch(e=>e.message)])');assert state['refresh']-before==1;assert await page.locator('#email').count()==1;assert await page.locator('#detail').inner_html()==''
  print('PASS: concurrent refresh coalesced; second 401 logs out and clears private UI')
  state['denied']=False;state['role']='store';await page.reload();await page.wait_for_selector('#loginErr');await page.wait_for_function('document.querySelector("#loginErr").textContent.includes("Store accounts")');assert await page.locator('#homeCapture').count()==0
  print('PASS: store login cannot enter HQ workspace')
  state['role']='hq';await page.reload();await page.wait_for_selector('#homeCapture');await page.evaluate('newTicket()');assert await page.evaluate('handleAndroidBack()');assert not await page.locator('#detail').evaluate('(e)=>e.classList.contains("show")')
  await page.evaluate('go("tickets")');assert await page.evaluate('handleAndroidBack()');assert await page.locator('#homeCapture').count()==1
  await page.screenshot(path=str(ROOT/'tests/hq-home.png'),full_page=True)
  print('PASS: Android Back closes dialog, then returns to Today')
  assert not errors,errors
  print('PASS: no browser runtime errors')
  await browser.close()
 server.shutdown()
if __name__=='__main__':asyncio.run(main())
