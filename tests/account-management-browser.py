#!/usr/bin/env python3
"""Isolated account-management UI checks. Every external request is mocked."""
import asyncio, functools, http.server, json, os, pathlib, threading
from playwright.async_api import async_playwright
ROOT=pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS=ROOT/'tests'/'artifacts'
ADMIN='10000000-0000-4000-8000-000000000001'
STAFF='10000000-0000-4000-8000-000000000002'
PARTNER='10000000-0000-4000-8000-000000000003'
A='20000000-0000-4000-8000-000000000001';B='20000000-0000-4000-8000-000000000002'
SESSION={'user':{'id':ADMIN},'access_token':'mock-access','refresh_token':'mock-refresh'}
class Quiet(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
async def main():
 ARTIFACTS.mkdir(exist_ok=True)
 server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(ROOT)))
 threading.Thread(target=server.serve_forever,daemon=True).start()
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None,headless=True,args=['--no-sandbox'])
  context=await browser.new_context(viewport={'width':390,'height':844},service_workers='block')
  page=await context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  state={'role':'admin','active':True,'requests':[],'delay':0,'lost_create':False}
  state['stores']=[{'id':A,'code':'HWD','name':'Hanok Woden','active':True},{'id':B,'code':'HWG','name':'Hanok Wagga','active':True}]
  state['accounts']=[{'user_id':ADMIN,'display_name':'Owner','email':'owner@example.invalid','role':'admin','active':True,'store_ids':[]},{'user_id':STAFF,'display_name':'Alex Chen','email':'alex@example.invalid','role':'store','active':True,'store_ids':[A]},{'user_id':PARTNER,'display_name':'Jamie Lee','email':'jamie@example.invalid','role':'partner','active':True,'store_ids':[A,B]}]
  async def route(r):
   url=r.request.url
   if url.startswith('http://127.0.0.1:'):return await r.continue_()
   status=200;body=[]
   if '/functions/v1/ops-admin-accounts' in url:
    data=r.request.post_data_json;state['requests'].append(data);await asyncio.sleep(state['delay'])
    if data['action']=='list':body={'accounts':state['accounts'],'stores':state['stores']}
    elif data['action']=='create_store':
     store=next((s for s in state['stores'] if s.get('requestId')==data['requestId']),None)
     if not store:
      store={'id':'20000000-0000-4000-8000-000000000099','name':data['name'],'code':data['code'],'active':True,'requestId':data['requestId']};state['stores'].append(store)
     if state.get('lost_store'):state['lost_store']=False;return await r.abort()
     body={'ok':True,'store':store,'request_id':data['requestId']}
    elif data['action']=='create':
     account=next((a for a in state['accounts'] if a.get('requestId')==data['requestId']),None)
     if not account:
      account={'user_id':'10000000-0000-4000-8000-000000000099','display_name':data['displayName'],'email':data['email'],'role':data['role'],'active':True,'store_ids':data['storeIds'],'requestId':data['requestId']};state['accounts'].append(account)
     if state['lost_create']:state['lost_create']=False;return await r.abort()
     body={'ok':True,'account':account}
    elif data['action']=='assign':
     account=next(a for a in state['accounts'] if a['user_id']==data['userId']);account['store_ids']=data['storeIds'];body={'ok':True,'account':account}
    elif data['action']=='deactivate':
     account=next(a for a in state['accounts'] if a['user_id']==data['userId']);account['active']=False;body={'ok':True,'account':account}
   elif '/rest/v1/ops_profiles' in url:body=[{'user_id':ADMIN,'display_name':'Owner','email':'owner@example.invalid','role':state['role'],'active':state['active'],'store_id':None}]
   elif '/rest/v1/ops_stores' in url:body=state['stores']
   elif '/rest/v1/ops_tickets' in url or '/rest/v1/ops_notifications' in url:body=[]
   elif 'api.github.com/' in url:status=404;body={}
   elif '/auth/v1/token' in url:body=SESSION
   else:raise AssertionError('Unexpected external request: '+url)
   await r.fulfill(status=status,content_type='application/json',body=json.dumps(body))
  await context.route('**/*',route)
  await page.add_init_script('localStorage.setItem("hanokops_session",'+json.dumps(json.dumps(SESSION))+')')
  await page.goto(f'http://127.0.0.1:{server.server_port}/android/app/src/main/assets/index.html');await page.wait_for_selector('#homeCapture');await page.wait_for_function('!document.querySelector("#loading.show")')
  await page.evaluate('go("profile")');await page.click('#accountManagementButton');await page.wait_for_function('!accountManagement.busy&&accountManagement.loaded')
  assert await page.locator('.accountCard').count()==3
  await page.screenshot(path=str(ARTIFACTS/'account-management-list.png'),full_page=True)
  await page.click('#newAccountButton');await page.fill('#accountName','Taylor');await page.fill('#accountEmail','taylor@example.invalid');await page.select_option('#accountRole','partner');await page.locator('[name="accountStores"]').nth(0).check();await page.locator('[name="accountStores"]').nth(1).check()
  await page.screenshot(path=str(ARTIFACTS/'account-management-create.png'),full_page=True)
  await page.fill('#accountPassword','Mock-test-password-123');state['lost_create']=True;await page.click('#accountSubmit');await page.wait_for_function('!accountManagement.busy');assert not await page.locator('#accountName').is_enabled();assert not await page.locator('#accountPassword').is_enabled();assert 'not confirmed' in await page.locator('#accountActionStatus').inner_text();await page.click('#accountSubmit');await page.wait_for_function('accountManagement.view==="list"&&!accountManagement.busy')
  requests=[r for r in state['requests'] if r['action']=='create'];assert len(requests)==2 and requests[0]==requests[1];assert len([a for a in state['accounts'] if a['email']=='taylor@example.invalid'])==1
  print('PASS: individual partner create, multi-store selection and lost-response retry')
  await page.locator('.accountCard').nth(2).get_by_text('Assign stores',exact=True).click();await page.locator('[name="accountStores"]').nth(0).uncheck();await page.click('#accountSubmit');await page.wait_for_function('accountManagement.view==="list"&&!accountManagement.busy');assert state['accounts'][2]['store_ids']==[B]
  await page.locator('.accountCard').nth(1).get_by_text('Deactivate',exact=True).click();assert not [r for r in state['requests'] if r['action']=='deactivate'];await page.get_by_text('Keep account active',exact=True).click();await page.wait_for_function('!accountManagement.busy');assert state['accounts'][1]['active']
  await page.locator('.accountCard').nth(1).get_by_text('Deactivate',exact=True).click();await page.click('#accountSubmit');await page.wait_for_function('accountManagement.view==="list"&&!accountManagement.busy');assert not state['accounts'][1]['active']
  print('PASS: store assignment, cancel and deliberate deactivation')
  await page.click('#newAccountButton');await page.fill('#accountName','Unfinished');await page.evaluate('refreshAll()');assert await page.input_value('#accountName')=='Unfinished';await page.evaluate('handleAndroidBack()');await page.wait_for_function('!accountManagement.busy');assert await page.locator('#accountPassword').count()==0
  print('PASS: background refresh preserves form, Android Back clears sensitive form')
  assert await page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
  await page.click('#newStoreButton');await page.fill('#newStoreName','Fictional North Store');await page.fill('#newStoreCode','FN1')
  await page.screenshot(path=str(ARTIFACTS/'new-store-form.png'),full_page=True)
  state['lost_store']=True;await page.click('#createStoreSubmit');await page.wait_for_function('!accountManagement.busy');assert not await page.locator('#newStoreName').is_enabled();assert 'not confirmed' in await page.locator('#newStoreStatus').inner_text()
  await page.click('#createStoreSubmit');await page.wait_for_function('accountManagement.view==="list"&&!accountManagement.busy');assert len(state['stores'])==3
  store_requests=[r for r in state['requests'] if r['action']=='create_store'];assert len(store_requests)==2 and store_requests[0]==store_requests[1]
  await page.click('#newAccountButton');await page.fill('#accountName','Draft Person');await page.click('#inlineNewStoreButton');await page.fill('#newStoreName','Second Fictional Store');await page.fill('#newStoreCode','FN2')
  await page.screenshot(path=str(ARTIFACTS/'new-store-inline.png'),full_page=True)
  await page.get_by_text('Cancel new store',exact=True).click();assert await page.input_value('#accountName')=='Draft Person';assert await page.locator('#accountSubmit').is_enabled();await page.evaluate('handleAndroidBack()');await page.wait_for_function('!accountManagement.busy')
  print('PASS: new store form, lost-response retry, inline cancellation and draft preservation')
  state['role']='hq';await page.evaluate('refreshAll()');assert await page.locator('#accountManagementButton').count()==0;assert await page.evaluate('accountManagement.accounts.length')==0
  state['active']=False;await page.evaluate('refreshAll()');assert await page.locator('#email').count()==1;assert await page.evaluate('session===null')
  print('PASS: demotion and deactivation clear account-management data; narrow layout fits')
  assert not errors,errors
  await browser.close()
 server.shutdown()
if __name__=='__main__':asyncio.run(main())
