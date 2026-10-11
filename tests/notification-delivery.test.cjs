const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const html=fs.readFileSync('android/app/src/main/assets/index.html','utf8');
const source=html.match(/function notifyNewNotifications\(\)\{[^\n]+/)[0];
const native=fs.readFileSync('android/app/src/main/java/com/hanokgroup/ops/NotificationDelivery.java','utf8');
const worker=fs.readFileSync('android/app/src/main/java/com/hanokgroup/ops/NotificationPollJob.java','utf8');
const activity=fs.readFileSync('android/app/src/main/java/com/hanokgroup/ops/MainActivity.java','utf8');
function foreground(notifications,notifyAlerts){
 const context={notifications,session:{refresh_token:'synthetic-session'},hydrateNativeSession(){},window:{AndroidApp:{notifyAlerts}}};
 vm.createContext(context);vm.runInContext(source,context);return context;
}
function run(context){vm.runInContext('notifyNewNotifications()',context)}

test('100 unread foreground rows cross the bridge in one batch with its session guard',()=>{
 const batches=[];const rows=Array.from({length:100},(_,i)=>({id:'alert-'+i,title:'Synthetic',read_at:null}));
 const context=foreground([...rows,{id:'read',read_at:'already read'}],(json,token)=>batches.push({rows:JSON.parse(json),token}));
 run(context);assert.equal(batches.length,1);assert.equal(batches[0].rows.length,100);
 assert.equal(batches[0].token,'synthetic-session');assert.deepEqual(batches[0].rows,rows);
});
test('foreground rehydrates a native-rotated session immediately before passing its batch',()=>{
 let passedToken;const context=foreground([{id:'a',read_at:null}],(json,token)=>{passedToken=token});
 context.hydrateNativeSession=()=>{context.session.refresh_token='synthetic-rotated'};
 run(context);assert.equal(passedToken,'synthetic-rotated');
});
test('blocked or failed batches remain available on later polls without a JavaScript ledger',()=>{
 let allowed=false, attempts=0,posted=0;const ledger=new Set();
 const context=foreground([{id:'a',read_at:null},{id:'b',read_at:null}],json=>{
  attempts++;if(!allowed)return false;
  const fresh=JSON.parse(json).filter(n=>!ledger.has(n.id));
  if(fresh.length){posted++;fresh.forEach(n=>ledger.add(n.id))}return true;
 });
 context.localStorage={getItem(){throw Error('Legacy unacknowledged ledger must not suppress retry')}};
 run(context);assert.equal(attempts,1);assert.equal(posted,0);
 allowed=true;run(context);run(context);assert.equal(attempts,3);assert.equal(posted,1);
 let failures=0;context.window.AndroidApp.notifyAlerts=()=>{failures++;throw Error('Synthetic native failure')};
 run(context);run(context);assert.equal(failures,2);
});
test('read-only Inbox, missing session and old bridge do not trigger per-row replay',()=>{
 let attempts=0;const context=foreground([{id:'read',read_at:'read'}],()=>attempts++);
 run(context);context.notifications=[{id:'unread',read_at:null}];context.session=null;run(context);
 context.session={refresh_token:'synthetic-session'};context.window.AndroidApp={notifyAlert(){attempts++}};run(context);
 assert.equal(attempts,0);
});
test('Inbox and single-ticket taps preserve pending routing across app boot',()=>{
 const routeSource=html.slice(html.indexOf('function receiveNotificationTicket('),html.indexOf('function receiveSharedText('));
 const storage=new Map(),visits=[];const context={session:null,profile:null,tickets:[{id:'synthetic-ticket'}],
  localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
  go:p=>visits.push(p),openTicket:id=>visits.push(id),setTimeout:fn=>fn()};
 vm.createContext(context);vm.runInContext(routeSource,context);
 vm.runInContext('receiveNotificationInbox()',context);assert.deepEqual(visits,[]);
 context.session={};context.profile={role:'hq'};vm.runInContext('consumePendingTicket()',context);
 assert.deepEqual(visits,['alerts']);assert.equal(storage.size,0);
 vm.runInContext('receiveNotificationTicket("synthetic-ticket")',context);assert.deepEqual(visits,['alerts','synthetic-ticket']);
 context.session=null;vm.runInContext('receiveNotificationTicket("synthetic-ticket");receiveNotificationInbox()',context);
 context.session={};vm.runInContext('consumePendingTicket()',context);assert.equal(visits.at(-1),'alerts');
 assert.match(activity,/getBooleanExtra\("notification_inbox", false\)/);
 assert.match(activity,/"receiveNotificationInbox\(\)"/);
});
test('foreground/background use the same atomic native batch path and late session guard',()=>{
 assert.match(native,/static synchronized boolean postBatchForSession/);
 assert.match(native,/sameSession\(context, expectedRefreshToken\) && postBatch\(context, rows\)/);
 assert.ok(native.indexOf('manager.notify(')<native.indexOf('for (String id : deliveredIds) posted.add(id)'));
 assert.match(worker,/NotificationDelivery\.postBatchForSession\(this, newRefreshToken, notifications\)/);
 assert.match(worker,/synchronized \(NotificationDelivery\.class\) \{\s*if \(run != runGeneration \|\| foreground \|\| !newRefreshToken/);
 assert.match(activity,/NotificationDelivery\.postBatchForSession\(MainActivity.this, expectedRefreshToken, new JSONArray\(rowsJson\)\)/);
 assert.doesNotMatch(worker,/seen.add|postForSession\(this/);
});
test('diagnostics expose state but never tokens or ticket content',()=>{
 const method=activity.slice(activity.indexOf('private String notificationStatus()'),activity.indexOf('public class AppBridge'));
 for(const name of ['delivery','channelImportance','channelSound','jobScheduled','sessionAvailable','lastPollAt','lastPollResult'])assert.ok(method.includes('"'+name+'"'));
 assert.doesNotMatch(method,/out.put\("(?:access_token|refresh_token|ticket|body|email)/);
 assert.match(activity,/NotificationDelivery\.post\(MainActivity.this, null, "报告老板通知测试"/);
});

// Execute the production delivery class against small deterministic Android doubles.
// This verifies delivery/acknowledgment behavior, not Android OS scheduling, JSON parsing or sound.
// A JDK is optional for JavaScript-only development and required for Android validation.
const javaAvailable=spawnSync('java',['--version'],{encoding:'utf8'}).status===0;
test('native batch delivery, retry, cross-path dedupe, routes, session guards and bounded ledger',
 {skip:javaAvailable?false:'Java is unavailable; run this native mock test with JDK 17+'},()=>{
 const production=native.split('\n').filter(line=>!/^package |^import /.test(line)).join('\n')
  .replace('final class NotificationDelivery','static final class NotificationDelivery');
 const harness=`import java.util.*;
public class NotificationDeliveryHarness {
 static class Manifest {static class permission {static final String POST_NOTIFICATIONS="post";}}
 static class PackageManager {static final int PERMISSION_GRANTED=0;}
 static class Build {static class VERSION {static int SDK_INT=35;}}
 static class R {static class drawable {static int ic_launcher=1;}}
 static class MainActivity {}
 static class NotificationPollJob {static String PREFS="test";}
 static class Intent {
  static int FLAG_ACTIVITY_CLEAR_TOP=1,FLAG_ACTIVITY_SINGLE_TOP=2;
  Map<String,Object> extras=new HashMap<>();String action;
  Intent(Context c,Class<?> k){}void setFlags(int flags){}
  void putExtra(String key,String value){extras.put(key,value);}void putExtra(String key,boolean value){extras.put(key,value);}
  void setAction(String value){action=value;}
 }
 static class PendingIntent {
  static int FLAG_UPDATE_CURRENT=1,FLAG_IMMUTABLE=2;Intent launch;
  static PendingIntent getActivity(Context c,int id,Intent intent,int flags){PendingIntent p=new PendingIntent();p.launch=intent;return p;}
 }
 static class Notification {
  String title,body;PendingIntent pending;
  static class BigTextStyle {BigTextStyle bigText(String text){return this;}}
  static class Builder {
   Notification n=new Notification();Builder(Context c){}Builder(Context c,String channel){}
   Builder setSmallIcon(int id){return this;}Builder setContentIntent(PendingIntent p){n.pending=p;return this;}
   Builder setContentTitle(String text){n.title=text;return this;}Builder setContentText(String text){n.body=text;return this;}
   Builder setStyle(BigTextStyle style){return this;}Builder setAutoCancel(boolean value){return this;}Notification build(){return n;}
  }
 }
 static class NotificationChannel {
  int importance;NotificationChannel(String id,String title,int value){importance=value;}
  int getImportance(){return importance;}void setDescription(String description){}
 }
 static class NotificationManager {
  static int IMPORTANCE_NONE=0,IMPORTANCE_HIGH=4;boolean enabled=true,fail=false;int posts=0;
  Notification last;String tag;Runnable beforeNotify=()->{};NotificationChannel channel=new NotificationChannel("test","test",4);
  boolean areNotificationsEnabled(){return enabled;}NotificationChannel getNotificationChannel(String id){return channel;}
  void cancelAll(){last=null;}
  void createNotificationChannel(NotificationChannel value){if(channel==null)channel=value;}
  void notify(String value,int id,Notification n){beforeNotify.run();if(fail)throw new SecurityException("Synthetic failure");posts++;tag=value;last=n;}
 }
 static class SharedPreferences {
  Map<String,Object> data=new HashMap<>();String getString(String key,String fallback){return (String)data.getOrDefault(key,fallback);}
  Editor edit(){return new Editor();}class Editor {
   Editor putString(String key,String value){data.put(key,value);return this;}
   Editor putLong(String key,long value){data.put(key,value);return this;}void apply(){}
  }
 }
 static class Context {
  static int MODE_PRIVATE=0;boolean permission=true;NotificationManager manager=new NotificationManager();SharedPreferences prefs=new SharedPreferences();
  int checkSelfPermission(String p){return permission?0:1;}<T>T getSystemService(Class<T> type){return type.cast(manager);}
  SharedPreferences getSharedPreferences(String name,int mode){return prefs;}
 }
 // Minimal codec for synthetic ledger IDs; production uses Android org.json.
 static class JSONArray {
  List<Object> values=new ArrayList<>();JSONArray(){}JSONArray(Collection<String> ids){values.addAll(ids);}
  JSONArray(String s){if(!s.startsWith("[")||!s.endsWith("]"))throw new IllegalArgumentException();if(s.length()>2)values.addAll(Arrays.asList(s.substring(1,s.length()-1).split(",")));}
  JSONArray put(Object value){values.add(value);return this;}int length(){return values.size();}
  String optString(int i,String fallback){return values.get(i)==null?fallback:values.get(i).toString();}
  JSONObject optJSONObject(int i){return values.get(i) instanceof JSONObject?(JSONObject)values.get(i):null;}
  public String toString(){return "["+String.join(",",values.stream().map(Object::toString).toList())+"]";}
 }
 static class JSONObject {
  Map<String,Object> values=new HashMap<>();JSONObject put(String key,Object value){values.put(key,value);return this;}
  boolean isNull(String key){return values.get(key)==null;}
  String optString(String key,String fallback){return values.get(key)==null?fallback:values.get(key).toString();}
 }
 ${production}
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 static Context session(){Context c=new Context();c.prefs.edit().putString("refresh_token","synthetic-current").apply();return c;}
 static JSONObject row(String id){return new JSONObject().put("id",id).put("title","Synthetic "+id).put("body","Synthetic body").put("ticket_id","ticket-"+id);}
 static JSONArray batch(String prefix,int count){JSONArray rows=new JSONArray();for(int i=count-1;i>=0;i--)rows.put(row(prefix+i));return rows;}
 static boolean deliver(Context c,JSONArray rows){return NotificationDelivery.postBatchForSession(c,"synthetic-current",rows);}
 static int acknowledged(Context c){return new JSONArray(c.prefs.getString(NotificationDelivery.ACKS,"[]")).length();}
 public static void main(String[] args)throws Exception {
  JSONArray hundred=batch("alert-",100);Context c=session();
  c.manager.beforeNotify=()->check(acknowledged(c)==0,"IDs must not be acknowledged before notify succeeds");
  check(deliver(c,hundred),"100-row batch must post");check(c.manager.posts==1,"100 rows must submit only once");
  check(acknowledged(c)==100,"digest acknowledges every included ID");check(c.manager.last.title.contains("100"),"digest count");
  check(c.manager.last.body.contains("Open Inbox"),"digest must direct to Inbox");
  check(Boolean.TRUE.equals(c.manager.last.pending.launch.extras.get("notification_inbox")),"digest routes to Inbox");
  check(!c.manager.last.pending.launch.extras.containsKey("ticket_id"),"digest cannot open an arbitrary ticket");
  c.manager.beforeNotify=()->{};check(deliver(c,hundred)&&c.manager.posts==1,"repeat batch must not resubmit");
  check(NotificationDelivery.post(c,"alert-1","test","test","")&&c.manager.posts==1,"legacy single-row entrypoint shares ledger");
  JSONArray mixed=batch("alert-",100);mixed.put(row("new-single"));check(deliver(c,mixed),"mixed batch");
  check(c.manager.posts==2&&c.manager.last.title.equals("Synthetic new-single"),"only one unseen row keeps individual content");
  check("ticket-new-single".equals(c.manager.last.pending.launch.extras.get("ticket_id")),"single row keeps ticket deep link");
  check(!c.manager.last.pending.launch.extras.containsKey("notification_inbox"),"ticket PendingIntent is distinct");
  check(deliver(c,new JSONArray().put(row("same-id")).put(row("same-id"))),"within-batch duplicate");
  check(c.manager.last.title.equals("Synthetic same-id"),"duplicate rows do not inflate digest count");
  int before=c.manager.posts;check(deliver(c,new JSONArray().put(row("read").put("read_at","read")).put(new JSONObject()).put(null)),"invalid or read rows ignored");
  check(c.manager.posts==before,"read or invalid rows must not post");
  check(deliver(c,new JSONArray().put(row("no-ticket").put("ticket_id",null))),"null ticket row");
  check(Boolean.TRUE.equals(c.manager.last.pending.launch.extras.get("notification_inbox")),"null ticket routes to Inbox");
  for(String block:List.of("permission","app","channel","service","failure")) {
   Context denied=session();NotificationManager manager=denied.manager;
   if(block.equals("permission"))denied.permission=false;
   if(block.equals("app"))manager.enabled=false;
   if(block.equals("channel"))manager.channel.importance=0;
   if(block.equals("service"))denied.manager=null;
   if(block.equals("failure"))manager.fail=true;
   check(!deliver(denied,hundred),block+" must report unsuccessful delivery");
   check(acknowledged(denied)==0&&manager.posts==0,block+" must consume zero IDs");
   denied.permission=true;denied.manager=manager;manager.enabled=true;manager.channel.importance=4;manager.fail=false;
   check(deliver(denied,hundred)&&manager.posts==1&&acknowledged(denied)==100,block+" retries one complete digest");
  }
  Context guarded=session();check(!NotificationDelivery.postBatchForSession(guarded,"synthetic-old",hundred),"changed session rejected");
  check(!NotificationDelivery.postBatchForSession(guarded,null,hundred),"missing expected session rejected");
  guarded.prefs.edit().putString("refresh_token","").apply();check(!NotificationDelivery.postBatchForSession(guarded,"",hundred),"logged-out session rejected");
  check(guarded.manager.posts==0&&acknowledged(guarded)==0,"session guard consumes no IDs");
  Context shared=session();Thread[] threads=new Thread[12];List<Throwable> errors=Collections.synchronizedList(new ArrayList<>());
  for(int i=0;i<threads.length;i++){threads[i]=new Thread(()->{try{check(deliver(shared,hundred),"concurrent delivery");}catch(Throwable error){errors.add(error);}});threads[i].start();}
  for(Thread thread:threads)thread.join();check(errors.isEmpty(),"concurrent caller failed");check(shared.manager.posts==1&&acknowledged(shared)==100,"foreground/background atomic dedupe");
  for(int i=1;i<=4;i++)check(deliver(shared,batch("page-"+i+"-",100)),"page digest");
  check(acknowledged(shared)==300,"ledger must stay bounded to 300 IDs");before=shared.manager.posts;
  check(deliver(shared,batch("page-4-",100))&&shared.manager.posts==before,"most recent batch retained");
  check(NotificationDelivery.post(shared,null,"Local test","Synthetic test",""),"local diagnostic still posts");
  check(shared.manager.posts==before+1&&acknowledged(shared)==300,"local diagnostic consumes no alert IDs");
  shared.prefs.edit().putString(NotificationDelivery.ACKS,"corrupt").apply();check(deliver(shared,batch("repair-",2)),"corrupt ledger cannot suppress new alerts");
  System.out.println("PASS native notification batch harness");
 }
}`;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reportboss-notification-test-'));
 try{
  const file=path.join(dir,'NotificationDeliveryHarness.java');fs.writeFileSync(file,harness);
  const result=spawnSync('java',[file],{encoding:'utf8',timeout:90000});
  assert.equal(result.status,0,[result.error?.message,result.stdout,result.stderr].filter(Boolean).join('\n'));
  assert.match(result.stdout,/PASS native notification batch harness/);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
