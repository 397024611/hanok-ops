const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const activity=fs.readFileSync('android/app/src/main/java/com/hanokgroup/ops/MainActivity.java','utf8');
const worker=fs.readFileSync('android/app/src/main/java/com/hanokgroup/ops/NotificationPollJob.java','utf8');
const source=fs.readFileSync('android/app/src/main/java/com/hanokgroup/ops/NativeSessionState.java','utf8');

test('Android packages generated same-origin workspaces with no new manifest permissions',()=>{
 const gradle=fs.readFileSync('android/app/build.gradle','utf8');
 assert.match(gradle,/main\.assets\.srcDirs = \["\.\.\/\.\.\/mobile-dist"\]/);
 assert.match(gradle,/commandLine 'node', 'scripts\/build-mobile\.cjs'/);
 assert.match(gradle,/dependsOn tasks\.named\('prepareMobileAssets'\)/);
 assert.match(activity,/LOCAL_HOST = "hanokops\.local"/);
 const manifest=fs.readFileSync('android/app/src/main/AndroidManifest.xml','utf8');
 const permissions=[...manifest.matchAll(/<uses-permission android:name="([^"]+)"/g)].map(m=>m[1]).sort();
 assert.deepEqual(permissions,['android.permission.ACCESS_NETWORK_STATE','android.permission.INTERNET','android.permission.POST_NOTIFICATIONS','android.permission.RECEIVE_BOOT_COMPLETED'].sort());
});
test('background notification scope revalidates active role and selects only own recipient rows',()=>{
 assert.match(worker,/ops_profiles\?select=user_id,role,active&user_id=eq\./);
 assert.match(worker,/profile\.optBoolean\("active", false\)/);
 assert.match(worker,/NativeSessionState\.knownRole\(profile\.optString\("role", ""\)\)/);
 assert.match(worker,/recipient_id=eq\." \+ owner/);
 assert.ok(worker.indexOf('getActiveProfile(accessToken, owner)')<worker.indexOf('getUnreadNotifications(accessToken, owner)'));
 assert.match(worker,/if \(run != runGeneration\) return/);
 assert.match(worker,/runGeneration\+\+;\s*recordPoll\("job_stopped"\)/);
});
test('stopped refresh preserves rotated credentials by CAS but cannot fetch or post afterward',()=>{
 const refreshCommit=worker.slice(worker.indexOf('// Preserve a successful token rotation'),worker.indexOf('String owner = NativeSessionState.owner'));
 assert.ok(refreshCommit.indexOf('NativeSessionState.save(')<refreshCommit.indexOf('if (run != runGeneration) return'));
 assert.match(refreshCommit,/null, refreshToken, true/);
});
test('session mutation and scheduler cancellation share the delivery lock; periodic job is not reset on refresh',()=>{
 const save=activity.slice(activity.indexOf('private boolean saveNativeSession'),activity.indexOf('private void scheduleNotificationJob'));
 assert.match(save,/synchronized \(NotificationDelivery\.class\)/);
 assert.match(save,/NativeSessionState\.save/);assert.match(save,/NativeSessionState\.clear/);
 assert.match(save,/scheduler\.cancel\(NotificationPollJob\.JOB_ID\)/);
 assert.match(activity,/scheduler\.getPendingJob\(NotificationPollJob\.JOB_ID\) != null\) return/);
 for(const method of ['saveRoleSession','updateRoleSession','clearSessionIfCurrent'])assert.ok(activity.includes('public boolean '+method+'('));
});
test('native routing remains pending across entry pages without handlers and rejects stale callbacks',()=>{
 const routes=activity.slice(activity.indexOf('private void deliverPendingTicket'),activity.indexOf('protected void onNewIntent'));
 assert.match(routes,/typeof window\./);assert.match(routes,/return false/);
 assert.match(routes,/if \(!"true"\.equals\(result\) \|\| generation != ticketRouteGeneration\) return/);
 assert.match(routes,/ticketDeliveryGeneration == generation/);
 assert.match(routes,/shareDeliveryGeneration == generation/);
 assert.match(activity,/ticketRouteGeneration\+\+;\s*shareRouteGeneration\+\+;/);
});

const hasJava=spawnSync('java',['--version'],{encoding:'utf8'}).status===0;
test('native session CAS keeps cross-role refresh/logout from replacing another account',
 {skip:hasJava?false:'JDK required for native session harness'},()=>{
 const production=source.split('\n').filter(l=>!/^package |^import /.test(l)).join('\n').replace('final class NativeSessionState','static final class NativeSessionState');
 const harness=`import java.util.*;import java.nio.charset.StandardCharsets;
 public class NativeSessionHarness {
 static class NotificationDelivery {static final String ACKS="ledger";}
 static class Base64 {static final int URL_SAFE=1,NO_PADDING=2,NO_WRAP=4;static byte[] decode(String s,int flags){return java.util.Base64.getUrlDecoder().decode(s);}}
 static class JSONObject {String text;JSONObject(String value){text=value;}String optString(String key,String fallback){String marker="\\\""+key+"\\\":\\\"";int start=text.indexOf(marker);if(start<0)return fallback;start+=marker.length();int end=text.indexOf('"',start);return end<0?fallback:text.substring(start,end);}}
 static class SharedPreferences {Map<String,String> data=new HashMap<>();String getString(String key,String fallback){return data.getOrDefault(key,fallback);}Editor edit(){return new Editor();}class Editor{Editor remove(String key){data.remove(key);return this;}Editor putString(String k,String v){data.put(k,v);return this;}void apply(){}}}
 ${production}
 static void check(boolean ok,String why){if(!ok)throw new AssertionError(why);}
 static String token(String owner){return "header."+java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(("{\\\"sub\\\":\\\""+owner+"\\\"}").getBytes(StandardCharsets.UTF_8))+".signature";}
 public static void main(String[] args){
 String a=token("11111111-1111-4111-8111-111111111111"),b=token("22222222-2222-4222-8222-222222222222");SharedPreferences p=new SharedPreferences();
 check(NativeSessionState.save(p,a,"admin-1","admin",null,false),"admin login");p.edit().putString("ledger","old-alert").apply();
 check(NativeSessionState.save(p,a,"admin-2","hq","admin-1",true),"same owner role refresh");check(p.getString("ledger","").equals("old-alert"),"same-owner ledger preserved");
 check(!NativeSessionState.save(p,a,"stale","admin","admin-1",true),"stale refresh rejected");
 check(NativeSessionState.save(p,b,"staff-1","store",null,false),"staff login");check(!p.data.containsKey("ledger"),"new owner clears ledger");
 check(!NativeSessionState.save(p,a,"old-background","admin","admin-2",true),"old worker rejected");check(!NativeSessionState.clear(p,"admin-2",true),"old logout rejected");check(p.getString("refresh_token","").equals("staff-1"),"staff remains active");
 check(!NativeSessionState.save(p,b,"invalid","pending","staff-1",true),"pending role rejected");check(!NativeSessionState.save(p,"invalid","invalid","hq",null,false),"invalid identity rejected");
 check(NativeSessionState.save(p,b,"partner-1","partner","staff-1",true),"validated role metadata may change");check(p.getString("session_role","").equals("partner"),"role metadata recorded");
 check(!NativeSessionState.save(p,a,"cross-owner","admin","partner-1",true),"CAS cannot change account");check(!NativeSessionState.clear(p,"",true),"empty CAS cannot sign out");
 check(NativeSessionState.clear(p,"partner-1",true),"current logout");check(!p.data.containsKey("refresh_token")&&!p.data.containsKey("session_role"),"session cleared");
 check(!NativeSessionState.save(p,b,"resurrected","partner","partner-1",true),"logout cannot resurrect");
 check(NativeSessionState.save(p,a,"legacy",null,null,false),"legacy bridge supported");check(p.getString("session_role","?").isEmpty(),"legacy role is informational only");
 System.out.println("PASS native session owner/role CAS and logout guards");
 }
 }`;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reportboss-native-session-'));try{const file=path.join(dir,'NativeSessionHarness.java');fs.writeFileSync(file,harness);const result=spawnSync('java',[file],{encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stdout+'\n'+result.stderr);assert.match(result.stdout,/PASS native session/);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('native chrome uses the light neutral surface with API-safe navigation icon contrast',()=>{
 const base=fs.readFileSync('android/app/src/main/res/values/styles.xml','utf8');
 const modern=fs.readFileSync('android/app/src/main/res/values-v27/styles.xml','utf8');
 assert.match(base,/#EEF0F2/);assert.match(base,/android:windowBackground">@color\/app_surface/);
 assert.match(base,/android:windowLightStatusBar">true/);assert.doesNotMatch(base,/name="android:windowLightNavigationBar"/);
 assert.match(modern,/android:windowLightNavigationBar">true/);assert.match(modern,/android:navigationBarColor">@color\/app_surface/);
 assert.match(activity,/webView\.setBackgroundColor\(0xFFEEF0F2\)/);
});

 test('account, role and logout transitions clear old posted tray alerts after guarded session mutation', () => {
  const main = fs.readFileSync('android/app/src/main/java/com/hanokgroup/ops/MainActivity.java', 'utf8');
  const worker = fs.readFileSync('android/app/src/main/java/com/hanokgroup/ops/NotificationPollJob.java', 'utf8');
  assert.match(main, /if \(saved\) \{[\s\S]*oldOwner\.equals[\s\S]*oldRole\.equals\(role\)[\s\S]*NotificationDelivery\.cancelPosted\(this\)/);
  assert.match(main, /NativeSessionState\.clear[\s\S]*return false;[\s\S]*NotificationDelivery\.cancelPosted\(this\)/);
  assert.match(worker, /!oldRole\.isEmpty\(\) && !oldRole\.equals\(role\)\) NotificationDelivery\.cancelPosted\(this\)/);
});
