(function(root){
'use strict';
const KEYS={hq:'hanokops_session',store:'hanok_store_session'},MARKER='reportboss_workspace';
const pending=['hanokops_pending_ticket','hanokops_pending_share'];
function valid(s){return !!(s?.user?.id&&s.access_token&&s.refresh_token);}
function changed(){return Object.assign(Error('The active account changed. Please sign in again.'),{invalidAccount:true});}
function claims(token){try{return JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')))}catch{return null}}
function createSessionStore(storage,bridge){
 let expected=null;
 function read(key){try{const s=JSON.parse(storage.getItem(key)||'null');return valid(s)?s:null}catch{return null}}
 function native(){try{return JSON.parse(bridge?.getStoredSession?.()||'null')}catch{return null}}
 function saved(){const hq=read(KEYS.hq),store=read(KEYS.store),hint=storage.getItem(MARKER);if(hint==='hq'&&hq)return hq;if(hint==='store'&&store)return store;if(hq&&store&&hq.user.id!==store.user.id)return null;return hq||store;}
 function hydrate(s){
  if(!valid(s))return s;const n=native();if(!n?.refresh_token)return s;
  const nc=claims(n.access_token),sc=claims(s.access_token);
  if(!nc?.sub)return s;if(nc.sub!==s.user.id)throw changed();
  expected=n.refresh_token;
  if(Number(nc.exp||0)<Number(sc?.exp||0))return s;
  return {...s,access_token:n.access_token,refresh_token:n.refresh_token};
 }
 function sync(s,p,newLogin=false){
  if(!valid(s)||p?.active!==true||p.user_id!==s.user.id||!['hq','admin','store','partner'].includes(p.role))return s;
  if(!bridge)return s;
  if(newLogin){if(bridge.saveRoleSession){if(bridge.saveRoleSession(s.access_token,s.refresh_token,p.role)===false)throw changed();}else bridge.saveSession?.(s.access_token,s.refresh_token);expected=s.refresh_token;return s;}
  const n=native(),owner=claims(n?.access_token)?.sub;
  if(owner&&owner!==s.user.id)throw changed();
  if(expected===null&&n?.refresh_token){expected=n.refresh_token;if(n.refresh_token!==s.refresh_token){const latest=hydrate(s);if(latest.refresh_token!==s.refresh_token)return latest;}}
  if(bridge.updateRoleSession&&expected!==null){
   if(!bridge.updateRoleSession(s.access_token,s.refresh_token,p.role,expected)){
    const next=hydrate(s);if(next.refresh_token===s.refresh_token)throw changed();return next;
   }
  }else if(bridge.saveRoleSession){if(bridge.saveRoleSession(s.access_token,s.refresh_token,p.role)===false)throw changed();}else bridge.saveSession?.(s.access_token,s.refresh_token);
  expected=s.refresh_token;return s;
 }
 function commit(s,route,p,{restoring=false}={}){
  if(!valid(s)||!Object.values(KEYS).includes(route.sessionKey))throw changed();
  const previous=saved();s=sync(s,p,!restoring);
  for(const key of Object.values(KEYS))storage.removeItem(key);
  if(!restoring||previous?.user.id!==s.user.id)for(const key of pending)storage.removeItem(key);
  storage.setItem(route.sessionKey,JSON.stringify(s));storage.setItem(MARKER,route.workspace);return s;
 }
 function clear(s){
  const n=native();let cleared=true;
  const replacementOwner=!!s&&Object.values(KEYS).some(key=>{const cached=read(key);return cached&&cached.user.id!==s.user.id;});
  if(!n?.refresh_token){cleared=true;}
  else if(bridge?.clearSessionIfCurrent&&s?.refresh_token){const token=claims(n?.access_token)?.sub===s.user.id?n.refresh_token:s.refresh_token;cleared=bridge.clearSessionIfCurrent(token);}
  else if(!n?.refresh_token||n.refresh_token===s?.refresh_token){bridge?.clearSession?.();}
  else cleared=false;
  for(const key of Object.values(KEYS)){const stored=read(key);if(!s||!stored||stored.user.id===s.user.id)storage.removeItem(key);}
  if(cleared&&!replacementOwner){storage.removeItem(MARKER);for(const key of pending)storage.removeItem(key);expected=null;}
  return cleared;
 }
 return {saved,hydrate,sync,commit,clear};
}
const api={KEYS,createSessionStore};if(typeof module==='object'&&module.exports)module.exports=api;else root.ReportBossSession=api;
})(typeof globalThis==='object'?globalThis:this);
