#!/usr/bin/env python3
"""Local-only interactive QA fixture. All application fetches are mocked in-page.
No credentials are needed; never use a real account. Run on loopback only.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
import argparse
ROOT = Path(__file__).resolve().parents[1]
MOCK = r'''<script>
(() => {
 const config = new URLSearchParams(location.search), mode=location.pathname.startsWith('/hq')?'hq':location.pathname.startsWith('/admin')?'admin':'store';
 const USER='11111111-1111-4111-8111-111111111111', STORE='22222222-2222-4222-8222-222222222222', TICKET='33333333-3333-4333-8333-333333333333', COMPLETED='44444444-4444-4444-8444-444444444444';
 const now=new Date().toISOString(), session={user:{id:USER},access_token:'mock-access-token',refresh_token:'mock-refresh-token'};
 const base={id:TICKET,ticket_no:1,store_id:STORE,created_by:USER,assigned_to:null,title:'Repair back door',description:'The back door hinge is loose. Please arrange a repair.',reported_by:'Sam (test)',category:'Maintenance',priority:'normal',status:'new',created_at:now,updated_at:now};
 const defaults={ops_tickets:[base,{...base,id:COMPLETED,ticket_no:2,title:'Fridge temperature issue',status:'completed',resolution:'Thermostat replaced and checked.',completed_at:now}],ops_ticket_events:[{id:'event-1',ticket_id:TICKET,event_type:'created',message:'Store reported this issue',created_at:now}],ops_ticket_comments:[],ops_ticket_attachments:[],ops_reopen_requests:[{id:'55555555-5555-4555-8555-555555555555',ticket_id:COMPLETED,store_id:STORE,requested_by:USER,reason:'Temperature is still too high.',status:'pending',created_at:now}],ops_notifications:[]};
 if(config.has('reset'))localStorage.removeItem('qa_fixture_rows');
 let rows;try{rows=JSON.parse(localStorage.getItem('qa_fixture_rows'))||defaults}catch{rows=defaults}
 const qa=window.__qa={rows,calls:[],mode,role:mode,delay:Number(config.get('delay')||0),uploadFail:config.has('uploadFail'),metadataFail:config.has('metadataFail'),authFail:false,refreshFail:false,refreshes:0,errors:[],blocked:[]};
 window.addEventListener('error',e=>qa.errors.push(e.message));window.addEventListener('unhandledrejection',e=>qa.errors.push(String(e.reason)));
 const save=()=>localStorage.setItem('qa_fixture_rows',JSON.stringify(rows));
 const json=(body,status=200)=>new Response(status===204?null:JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
 const clone=x=>JSON.parse(JSON.stringify(x));
 const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 localStorage.removeItem('hanokops_session');localStorage.removeItem('hanok_store_session');
 if(!config.has('loggedOut')&&mode!=='admin')localStorage.setItem(mode==='hq'?'hanokops_session':'hanok_store_session',JSON.stringify(session));
 const fakeFetch=async(input,opts={})=>{
  const url=new URL(String(input),location.href),method=opts.method||'GET',headers=new Headers(opts.headers),isJSON=headers.get('content-type')?.includes('application/json'),data=isJSON&&opts.body?JSON.parse(opts.body):{};
  qa.calls.push({url:url.href,method,data:clone(data)});if(qa.delay)await delay(qa.delay);if(opts.signal?.aborted)throw new DOMException('Aborted','AbortError');
  if(url.hostname==='api.github.com')return json({},404);
  if(url.pathname==='/api/hanok-ai')return json({error:'Mock AI unavailable: use local capture suggestions.'},503);
  if(url.origin!=='https://tqfwbsjchespjkxliodo.supabase.co'){qa.blocked.push(url.href);throw new Error('QA blocked unexpected external request: '+url.href)}
  if(url.pathname==='/auth/v1/token'){if(url.searchParams.get('grant_type')==='refresh_token'){qa.refreshes++;if(qa.refreshFail)return json({message:'Mock refresh outage'},503);return json({...session,access_token:'mock-refreshed-token'})}return json(session)}
  if(url.pathname==='/auth/v1/logout')return json({});
  if(url.pathname.startsWith('/auth/'))return json({message:'This auth operation is not supported by the QA fixture'},400);
  if(qa.authFail)return json({message:'Mock unauthorized'},401);
  if(url.pathname==='/functions/v1/ops-admin-store-user')return json({ok:true,username:'Hanok Woden',storeCode:data.storeCode});
  if(url.pathname.startsWith('/storage/')){
   if(method==='POST'){if(qa.uploadFail){qa.uploadFail=false;return json({message:'Mock upload failed once. Retry safely.'},503)}return json({Key:'mock-upload'})}
   const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1kAAAAASUVORK5CYII='),c=>c.charCodeAt(0));return new Response(bytes,{headers:{'Content-Type':'image/png'}});
  }
  if(url.pathname.endsWith('/ops_profiles'))return json([{user_id:USER,display_name:mode==='store'?'Store Test':'HQ Test',email:'test@example.invalid',role:qa.role,store_id:mode==='store'?STORE:null}]);
  if(url.pathname.endsWith('/ops_stores'))return json([{id:STORE,code:'HWD',name:'Hanok Woden',active:true}]);
  if(url.pathname.endsWith('/rpc/ops_review_reopen_request')){const r=rows.ops_reopen_requests.find(x=>x.id===data.p_request_id);if(!r)return json({message:'Request not found'},404);r.status=data.p_approve?'approved':'rejected';r.reviewed_at=new Date().toISOString();if(data.p_approve){const ticket=rows.ops_tickets.find(x=>x.id===r.ticket_id);ticket.status='in_progress';ticket.resolution=null;ticket.completed_at=null;ticket.updated_at=new Date().toISOString()}save();return json(null)}
  const table=url.pathname.split('/').pop();if(!rows[table]){qa.blocked.push(url.href);return json({message:'Unexpected mock endpoint'},500)}
  if(method==='POST'){
   if(table==='ops_ticket_attachments'&&qa.metadataFail){qa.metadataFail=false;return json({message:'Mock metadata failure once. Retry attachment.'},503)}
   if(data.id&&rows[table].some(r=>r.id===data.id))return json({message:'Duplicate id',code:'23505'},409);
   if(table==='ops_reopen_requests'&&rows[table].some(r=>r.ticket_id===data.ticket_id&&r.status==='pending'))return json({message:'A request is pending',code:'23505'},409);
   if(table==='ops_ticket_attachments'&&rows[table].some(r=>r.storage_path===data.storage_path))return json(null);
   const row={id:crypto.randomUUID(),created_at:new Date().toISOString(),updated_at:new Date().toISOString(),...data};
   if(table==='ops_tickets'){row.status='new';row.ticket_no=rows.ops_tickets.length+1}if(table==='ops_reopen_requests')row.status='pending';rows[table].unshift(row);save();return json([row]);
  }
  let result=rows[table].filter(row=>{for(const [key,value]of url.searchParams){if(value.startsWith('eq.')&&String(row[key])!==value.slice(3))return false;if(value==='is.null'&&row[key]!=null)return false}return true});
  if(method==='PATCH'){result.forEach(row=>Object.assign(row,data,{updated_at:new Date().toISOString()}));save();return json(result)}
  const offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||result.length);return json(result.slice(offset,offset+limit));
 };
 Object.defineProperty(window,'fetch',{value:fakeFetch,writable:false,configurable:false});
 window.XMLHttpRequest=function(){throw new Error('Network disabled by local QA fixture')};window.WebSocket=function(){throw new Error('Network disabled by local QA fixture')};
 navigator.sendBeacon=()=>false;
})();
</script>'''

class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  route=urlsplit(self.path).path
  targets={'/store':ROOT/'store-portal/index.html','/hq':ROOT/'android/app/src/main/assets/index.html','/admin':ROOT/'store-portal/admin.html'}
  if route in targets:
   source=targets[route].read_text(); body=source.replace('<script>',MOCK+'\n<script>',1)
  elif route=='/health':
   self.send_response(200);self.end_headers();self.wfile.write(b'mock-only fixture ready');return
  else:
   body='<!doctype html><html><head><title>Mock QA</title></head><body><h1>Local mock QA only</h1><p>All fetches are intercepted; outbound requests are disabled by CSP.</p><p><a href="/store?reset=1">Store</a> | <a href="/hq">HQ</a> | <a href="/admin">Admin</a></p><p>Fake login: test@example.invalid / mock-password. No real credentials.</p><p>Add ?loggedOut=1 for sign-in, ?uploadFail=1 or ?metadataFail=1 for one-time failures, ?delay=750 for slow responses, and ?reset=1 to reset fixture data.</p></body></html>'
  raw=body.encode();self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Content-Length',str(len(raw)));self.send_header('Cache-Control','no-store');self.send_header('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; media-src blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'");self.end_headers();self.wfile.write(raw)
 def log_message(self,fmt,*args):
  print(fmt%args,flush=True)

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8765);args=parser.parse_args()
 server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
 print(f'Mock-only QA: http://127.0.0.1:{args.port}/',flush=True)
 server.serve_forever()
