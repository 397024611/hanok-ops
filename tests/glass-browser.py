#!/usr/bin/env python3
"""Real generated entry/workspaces with isolated fictional API responses. No live account access."""
import asyncio, importlib.util, json, mimetypes, os
from pathlib import Path
from urllib.parse import urlsplit
from playwright.async_api import async_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
ARTIFACTS=ROOT/'tests/artifacts'
spec=importlib.util.spec_from_file_location('portal',Path(__file__).with_name('store-portal-browser.py'))
portal=importlib.util.module_from_spec(spec);spec.loader.exec_module(portal)
async def main():
 ARTIFACTS.mkdir(exist_ok=True)
 async with async_playwright() as p:
  browser=await p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH') or None,args=['--no-sandbox'])
  for role,entry,target in [('store','staff','store.html'),('partner','boss','store.html'),('admin','boss','hq.html')]:
   backend=portal.Backend();backend.role=role;backend.rows['ops_notifications']=[]
   backend.rows['ops_tickets']=[{**portal.ticket(title='Cool room above temperature'),'priority':'urgent'},portal.ticket('44444444-4444-4444-8444-444444444444',title='POS terminal disconnecting'),portal.ticket('55555555-5555-4555-8555-555555555555',title='Kitchen tap leaking')]
   context=await browser.new_context(viewport={'width':390,'height':844},service_workers='block')
   page=await context.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
   async def route(r):
    url=urlsplit(r.request.url)
    if url.netloc=='reportboss.test':
     file=(ROOT/'mobile-dist'/(url.path.lstrip('/') or 'index.html')).resolve()
     if not file.is_relative_to((ROOT/'mobile-dist').resolve()) or not file.is_file():return await r.fulfill(status=404,body='Not found')
     return await r.fulfill(content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream',body=file.read_bytes())
    if url.netloc=='api.github.com':return await r.fulfill(status=404,json={})
    if url.netloc!='tqfwbsjchespjkxliodo.supabase.co':raise AssertionError('Unexpected external request '+r.request.url)
    if url.path=='/auth/v1/user':return await r.fulfill(json={'id':portal.USER})
    if url.path.endswith('/ops_profiles'):return await r.fulfill(json=[{'user_id':portal.USER,'role':role,'active':True,'display_name':'Test account','store_id':portal.STORE if role=='store' else None}])
    return await backend.normal(r,r.request,url)
   await page.route('**/*',route)
   await page.goto('https://reportboss.test/index.html')
   if role=='store':await page.screenshot(path=str(ARTIFACTS/'glass-entry-390.png'),full_page=False)
   await page.click('[data-entry='+entry+']')
   if role=='admin':
    await page.click('#account-help');await page.wait_for_url('https://reportboss.test/hq.html#account-help');await expect(page.get_by_role('button',name='Forgot password',exact=True)).to_be_visible();await expect(page.get_by_role('button',name='Create account',exact=True)).to_be_visible();await page.screenshot(path=str(ARTIFACTS/'glass-account-help-390.png'));await page.click('#accountHelpBack');await page.wait_for_url('https://reportboss.test/index.html');await page.click('[data-entry=boss]')
   await page.fill('#email','fixture@example.invalid');await page.fill('#password','fictional-only');await page.click('#submit')
   await page.wait_for_url('https://reportboss.test/'+target)
   if role=='admin':
    await page.wait_for_selector('#homeCapture');await page.get_by_role('button',name='Tickets',exact=True).click()
   else:await expect(page.locator('[data-ticket]')).to_have_count(3)
   assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
   assert await page.evaluate('getComputedStyle(document.body).backgroundImage')=='none'
   assert await page.evaluate('getComputedStyle(document.body).backgroundColor')=='rgb(245, 246, 248)'
   if role!='partner':
    assert await page.locator('.rb-title-row .primary').evaluate('(e)=>getComputedStyle(e).color')=='rgb(21, 90, 216)'
    assert 'gradient' in await page.locator('.rb-title-row .primary').evaluate('(e)=>getComputedStyle(e).backgroundImage')
   await page.screenshot(path=str(ARTIFACTS/('glass-'+role+'-tickets-390.png')),full_page=False)
   # Verify the authenticated layout, not just entry, at small, wide and landscape sizes.
   for width,height in [(320,844),(375,812),(768,900),(844,390)]:
    await page.set_viewport_size({'width':width,'height':height})
    assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    nav=await page.locator('nav.nav').bounding_box()
    assert nav and nav['x']>=0 and nav['y']>=0 and nav['x']+nav['width']<=width+1 and nav['y']+nav['height']<=height+1,nav
    assert await page.locator('nav.nav').evaluate('(e)=>getComputedStyle(e).position')=='fixed'
    for button in await page.locator('nav.nav button').all():
     box=await button.bounding_box();assert box['height']>=48 and box['width']>=48,box
    if height<520:
     first=page.locator('.rb-ticket').first;last=page.locator('.rb-ticket').last
     for ticket in [first,last]:
      await ticket.evaluate('(e)=>e.scrollIntoView({block:"center"})')
      rect=await ticket.bounding_box();nav=await page.locator('nav.nav').bounding_box()
      assert rect and rect['y']>=0 and rect['y']+min(rect['height'],100)<=nav['y'],(role,rect,nav)
    await page.screenshot(path=str(ARTIFACTS/(f'control-{role}-{width}x{height}.png')))
   await page.set_viewport_size({'width':390,'height':844})
   await page.emulate_media(reduced_motion='reduce')
   assert await page.locator('nav.nav button').first.evaluate('(e)=>getComputedStyle(e).transitionDuration')=='0s'
   await page.emulate_media(reduced_motion='no-preference')
   if role=='partner':assert await page.locator('.plus').count()==0;assert await page.locator('#assignedStore').count()==1
   if role!='admin':
    await page.fill('#storeTicketSearch','POS');await page.locator('.rb-store-search button').click();await expect(page.locator('[data-ticket]')).to_have_count(1)
    await page.get_by_role('button',name='Clear search',exact=True).click();await expect(page.locator('[data-ticket]')).to_have_count(3)
   else:
    await page.select_option('#ticketView','urgent');await expect(page.locator('.rb-ticket')).to_have_count(1)
    await page.select_option('#ticketView','active');await expect(page.locator('.rb-ticket')).to_have_count(3)

   if role=='store':
    await page.get_by_role('button',name='Report an issue',exact=True).click();await expect(page.get_by_role('dialog',name='Report Issue')).to_be_visible();await page.fill('#title','Unsubmitted draft');await page.get_by_role('button',name='Close',exact=True).click();await page.get_by_role('button',name='Report an issue',exact=True).click();assert await page.input_value('#title')=='Unsubmitted draft';await page.get_by_role('button',name='Close',exact=True).click()
   if role!='admin':
    await page.locator('[data-ticket]').first.click();await page.screenshot(path=str(ARTIFACTS/('glass-'+role+'-detail-390.png')),full_page=False);await page.get_by_role('button',name='Close',exact=True).click()
    await page.get_by_role('button',name='Profile',exact=True).click();await page.get_by_role('button',name='Reduce transparency',exact=True).click();assert await page.locator('html').evaluate('(e)=>e.classList.contains("reduce-glass")');assert await page.locator('nav.nav').evaluate('(e)=>getComputedStyle(e).backdropFilter')=='none';await page.get_by_role('button',name='Enable glass',exact=True).click();await page.get_by_role('button',name='Close',exact=True).click()
   await page.get_by_role('button',name='Profile',exact=True).click()
   await page.get_by_role('button',name='Sign out',exact=True).click();await page.wait_for_url('https://reportboss.test/index.html');await expect(page.locator('#choose')).to_be_visible();assert await page.evaluate('!localStorage.getItem("hanokops_session")&&!localStorage.getItem("hanok_store_session")')
   for width in [320,768]:
    await page.set_viewport_size({'width':width,'height':900});assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
   assert not errors,errors
   await context.close()
  await browser.close()
 print('PASS: generated Boss/Staff authentication, restricted partner, real ticket UI, draft reopen, profile/transparency, cross-workspace logout, responsive screenshots. All external APIs mocked.')
if __name__=='__main__':asyncio.run(main())
