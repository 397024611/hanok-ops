#!/usr/bin/env python3
"""Manual UI fixture. Synthetic data only; CSP blocks all real fetch traffic."""
from pathlib import Path
import http.server, importlib.util, json
ROOT=Path(__file__).resolve().parents[1]
ADMIN='10000000-0000-4000-8000-000000000001';STAFF='10000000-0000-4000-8000-000000000002';PARTNER='10000000-0000-4000-8000-000000000003'
A='20000000-0000-4000-8000-000000000001';B='20000000-0000-4000-8000-000000000002'
def build_html():
 state={'role':'admin','active':True,'stores':[{'id':A,'code':'HWD','name':'Hanok Woden','active':True},{'id':B,'code':'HWG','name':'Hanok Wagga','active':True}],'accounts':[{'user_id':ADMIN,'display_name':'Owner','email':'owner@example.invalid','role':'admin','active':True,'store_ids':[]},{'user_id':STAFF,'display_name':'Alex Chen','email':'alex@example.invalid','role':'store','active':True,'store_ids':[A]},{'user_id':PARTNER,'display_name':'Jamie Lee','email':'jamie@example.invalid','role':'partner','active':True,'store_ids':[A,B]}]}
 mock='''<script>
const mockState=STATE;
localStorage.setItem('hanokops_session',JSON.stringify({user:{id:ADMIN},access_token:'mock-access',refresh_token:'mock-refresh'}));
window.fetch=async(url,opts={})=>{
 let body=[],status=200;
 if(url.includes('/ops-admin-accounts')){
  const d=JSON.parse(opts.body);
  if(d.action==='list')body={accounts:mockState.accounts,stores:mockState.stores};
  if(d.action==='create'){
   let account=mockState.accounts.find(a=>a.requestId===d.requestId);
   if(!account){account={user_id:crypto.randomUUID(),display_name:d.displayName,email:d.email,role:d.role,active:true,store_ids:d.storeIds,requestId:d.requestId};mockState.accounts.push(account)}
   body={ok:true,account};
  }
  if(d.action==='assign'){const account=mockState.accounts.find(a=>a.user_id===d.userId);account.store_ids=d.storeIds;body={ok:true,account}}
  if(d.action==='deactivate'){const account=mockState.accounts.find(a=>a.user_id===d.userId);account.active=false;body={ok:true,account}}
 }else if(url.includes('/ops_profiles'))body=[{user_id:ADMIN,display_name:'Owner',email:'owner@example.invalid',role:mockState.role,active:mockState.active,store_id:null}];
 else if(url.includes('/ops_stores'))body=mockState.stores;
 else if(url.includes('api.github.com/')){status=404;body={}}
 else if(!url.includes('/ops_tickets')&&!url.includes('/ops_notifications'))throw Error('Unmocked request blocked');
 return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
};
</script>'''.replace('STATE',json.dumps(state)).replace('ADMIN',json.dumps(ADMIN))
 html=(ROOT/'android/app/src/main/assets/index.html').read_text().replace("frame-src 'none';","connect-src 'none'; frame-src 'none';")
 return html.replace('<script>',mock+'<script>',1)
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  if self.path=='/hq':html=build_html()
  elif self.path=='/portal':
   p=ROOT/'tests/store-accounts-preview.py';spec=importlib.util.spec_from_file_location('portal_preview',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);html=m.build_html()
  elif self.path=='/':html='<html><body style="background:#ece8e0;font:14px sans-serif"><p>Isolated UI preview · fictional data · no production network</p><iframe title="Account management preview" src="/hq" style="width:390px;height:790px;border:0"></iframe><iframe title="Partner portal preview" src="/portal" style="width:390px;height:790px;border:0;margin-left:20px"></iframe></body></html>'
  else:self.send_error(404);return
  data=html.encode();self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
 def log_message(self,*args):pass
if __name__=='__main__':
 server=http.server.ThreadingHTTPServer(('127.0.0.1',8765),Handler);print('Mock-only UI preview listening at http://127.0.0.1:8765',flush=True);server.serve_forever()
