#!/usr/bin/env python3
"""Isolated manual browser fixture. No production service requests or real credentials.
Import build_html() into a loopback fixture server, or print HTML with this script.
The visible fixture controls affect only in-memory fictional data.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

MOCK = r'''<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:; connect-src 'none'; form-action 'none'; base-uri 'none'">
<script>
(() => {
  const user='11111111-1111-4111-8111-111111111111';
  const first='22222222-2222-4222-8222-222222222222';
  const second='33333333-3333-4333-8333-333333333333';
  const token={access_token:'fictional-preview-access',refresh_token:'fictional-preview-refresh',user:{id:user}};
  const now='2026-10-08T10:00:00Z';
  const ticket=(id,store_id,title,status='new')=>({id,store_id,title,status,ticket_no:store_id===first?12:27,description:store_id===first?'Kitchen team noticed water under the sink. Please arrange an inspection.':'Front counter tablet loses connection during service.',reported_by:'Fixture staff',category:'Maintenance',priority:'normal',created_at:now,updated_at:now});
  const state=window.portalFixture={active:true,role:'partner',memberships:[first,second],calls:[],rows:{
    ops_tickets:[ticket('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',first,'Preview A: leaking kitchen sink'),ticket('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',second,'Preview B: POS connection drops')],
    ops_ticket_comments:[{id:'comment-a',ticket_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',body:'Preview A private note: plumber can visit tomorrow.',created_at:now},{id:'comment-b',ticket_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',body:'Preview B private note: router restarted.',created_at:now}],
    ops_ticket_events:[{id:'event-a',ticket_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',message:'Issue reported to HQ',event_type:'created',created_at:now}],
    ops_ticket_attachments:[],ops_reopen_requests:[]
  }};
  const stores=[{id:first,code:'PRA',name:'Preview Store A',active:true},{id:second,code:'PRB',name:'Preview Store B',active:true}];
  const json=(data,status=200)=>Promise.resolve(new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}}));
  const photo='<svg xmlns="http://www.w3.org/2000/svg" width="500" height="300"><rect width="500" height="300" fill="#ead5ad"/><text x="45" y="150" font-size="30" fill="#142532">Fictional attachment preview</text></svg>';
  // This replaces fetch before the production application script is evaluated.
  // Unmatched requests fail closed. CSP independently blocks network fetch/XHR.
  window.fetch=async(input,opts={})=>{
    const url=new URL(input,location.href),method=opts.method||'GET';
    if(url.origin!=='https://tqfwbsjchespjkxliodo.supabase.co')throw new Error('Network disabled in this fixture.');
    if(opts.signal?.aborted)throw new DOMException('Fixture request cancelled.','AbortError');
    const body=typeof opts.body==='string'?JSON.parse(opts.body):opts.body;
    state.calls.push({method,path:url.pathname,query:url.search});
    if(url.pathname==='/auth/v1/token')return json(token);
    if(url.pathname==='/auth/v1/logout')return json({});
    if(url.pathname.startsWith('/storage/'))return method==='POST'?json({Key:'fictional-upload'}):new Response(photo,{headers:{'Content-Type':'image/svg+xml'}});
    const table=url.pathname.split('/').pop();
    if(table==='ops_profiles')return json([{user_id:user,display_name:'Preview user',role:state.role,active:state.active,store_id:state.role==='store'?first:null}]);
    if(table==='ops_stores')return json(stores.filter(s=>state.memberships.includes(s.id)&&(!url.searchParams.has('id')||url.searchParams.get('id')==='eq.'+s.id)));
    if(!Object.hasOwn(state.rows,table))throw new Error('Unmocked fixture endpoint: '+url.pathname);
    if(method==='POST'){
      if(!state.active)return json({message:'Fixture account disabled'},403);
      if(state.rows[table].some(row=>row.id===body.id))return json({message:'duplicate'},409);
      const row={...body,created_at:now,updated_at:now};
      if(table==='ops_tickets'){if(state.role!=='store')return json({message:'Partners cannot create issues'},403);row.status='new';row.ticket_no=99;}
      if(table==='ops_reopen_requests'){if(state.role!=='store')return json({message:'Partners cannot request reopen'},403);row.status='pending';}
      state.rows[table].push(row);return json([row]);
    }
    let rows=state.rows[table];
    for(const key of ['id','ticket_id','store_id'])if(url.searchParams.has(key))rows=rows.filter(r=>r[key]===url.searchParams.get(key).slice(3));
    const offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||rows.length);
    return json(rows.slice(offset,offset+limit));
  };
  localStorage.setItem('hanok_store_session',JSON.stringify(token));
  addEventListener('DOMContentLoaded',()=>{
    const panel=document.createElement('aside');panel.id='fixtureControls';panel.setAttribute('aria-label','Isolated preview controls');
    panel.style.cssText='position:fixed;z-index:101;bottom:0;left:0;right:0;background:#fff3cd;border-top:2px solid #96703f;padding:9px;display:flex;flex-wrap:wrap;gap:7px;align-items:center;font:12px sans-serif;box-shadow:0 -3px 18px #0002';
    const label=document.createElement('strong');label.textContent='ISOLATED FIXTURE · fictional data · network blocked';panel.append(label);
    const action=(name,fn)=>{const b=document.createElement('button');b.textContent=name;b.type='button';b.style.cssText='padding:8px;border:1px solid #bd985d;border-radius:6px;background:white;color:#142532';b.onclick=fn;panel.append(b)};
    const reload=async()=>{if(window.loadTickets)await window.loadTickets();};
    action('Remove Store A',async()=>{state.memberships=[second];await reload()});
    action('Disable account',async()=>{state.active=false;await reload()});
    action('Make issue completed',async()=>{state.rows.ops_tickets.forEach(t=>{t.status='completed';t.resolution='Fixture repair complete.'});await reload()});
    action('Reset partner',()=>location.reload());
    action('Use staff account',async()=>{if(window.logout)window.logout(false);state.role='store';state.active=true;state.memberships=[first];window.setLoginMode('independent');document.getElementById('email').value='fictional.staff@example.test';document.getElementById('pwd').value='fixture-only';await window.login()});
    document.body.append(panel);
    const style=document.createElement('style');style.textContent='.main{padding-bottom:150px}.sheet{padding-bottom:150px}.login{padding-bottom:150px}';document.head.append(style);
  });
})();
</script>
'''

def build_html():
    """Return production HTML with a request-blocking mock inserted before its script."""
    source = (ROOT / 'store-portal' / 'index.html').read_text()
    return source.replace('<head>', '<head>\n' + MOCK, 1)

if __name__ == '__main__':
    print(build_html())
