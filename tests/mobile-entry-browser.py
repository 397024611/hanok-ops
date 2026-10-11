"""All account and API responses are fictional; no external network allowed."""
import asyncio,json,threading,http.server,functools,pathlib,os
from playwright.async_api import async_playwright
ROOT=pathlib.Path(__file__).resolve().parents[1]
class Quiet(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
async def main():
 server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(ROOT/'mobile-dist')))
 threading.Thread(target=server.serve_forever,daemon=True).start()
 async with async_playwright() as p:
  browser=await p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH') or None,args=['--no-sandbox'])
  context=await browser.new_context(viewport={'width':390,'height':844},service_workers='block')
  page=await context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  state={'role':'hq','active':True,'delay':False,'calls':0};base=f'http://127.0.0.1:{server.server_port}/'
  async def route(r):
   url=r.request.url
   if url in [base+'hq.html',base+'store.html']:return await r.fulfill(body='<h1>Verified workspace target</h1>',content_type='text/html')
   if url.startswith(base):return await r.continue_()
   if '/auth/v1/token?' in url:
    state['calls']+=1
    if state['delay']:await asyncio.sleep(.25)
    body={'access_token':'fictional-token','refresh_token':'fictional-refresh','user':{'id':'u'}}
   elif '/auth/v1/user' in url:body={'id':'u'}
   elif '/rest/v1/ops_profiles?' in url:body=[{'user_id':'u','active':state['active'],'role':state['role'],'store_id':'s1'}]
   elif '/rest/v1/ops_stores?' in url:body=[{'id':'s1','active':True},{'id':'s2','active':True}]
   else:raise AssertionError('Unexpected network: '+url)
   await r.fulfill(body=json.dumps(body),content_type='application/json')
  await page.route('**/*',route)
  await page.goto(base)
  assert await page.locator('[data-entry]').count()==2
  assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
  (ROOT/'tests/artifacts').mkdir(exist_ok=True)
  await page.screenshot(path=str(ROOT/'tests/artifacts/mobile-entry.png'),full_page=True)
  await page.click('[data-entry=staff]');assert await page.locator('#methods').is_visible()
  await page.fill('#password','fictional-only');await page.click('[data-method=shared]');assert await page.input_value('#password')==''
  assert await page.locator('#store-wrap').is_visible();await page.click('#back');assert await page.locator('#choose').is_visible()
  await page.click('[data-entry=boss]');assert not await page.locator('#methods').is_visible()
  await page.fill('#email','example@example.invalid');await page.fill('#password','fictional-only')
  state['role']='store';await page.click('#submit');await page.wait_for_function('document.querySelector("#error").textContent.includes("Staff Login")')
  assert await page.evaluate('localStorage.getItem("hanokops_session")') is None
  state['role']='hq';state['delay']=True;await page.fill('#password','fictional-only');await page.click('#submit');await page.click('#back');await page.wait_for_timeout(400)
  assert await page.locator('#choose').is_visible();assert await page.evaluate('localStorage.getItem("hanokops_session")') is None
  state['delay']=False
  for role,entry,target,key in [('hq','boss','hq.html','hanokops_session'),('partner','boss','store.html','hanok_store_session'),('store','staff','store.html','hanok_store_session')]:
   await page.evaluate('localStorage.clear()')
   state['role']=role;await page.goto(base);await page.click('[data-entry='+entry+']');await page.fill('#email','example@example.invalid');await page.fill('#password','fictional-only');await page.click('#submit');await page.wait_for_url(base+target)
   assert json.loads(await page.evaluate('(key)=>localStorage.getItem(key)',key))['user']['id']=='u'
  await page.evaluate('localStorage.clear()')
  for width in [320,768]:
   await page.set_viewport_size({'width':width,'height':900});await page.goto(base);assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
  assert not errors,errors
  print('PASS: responsive selector; personal/shared inputs; password clearing; wrong role denial; cancellation; verified HQ/partner/staff destinations. All APIs mocked.')
  await browser.close()
 server.shutdown()
asyncio.run(main())
