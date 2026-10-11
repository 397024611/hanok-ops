const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');

const activity = fs.readFileSync('android/app/src/main/java/com/hanokgroup/ops/MainActivity.java', 'utf8');
const javaAvailable = spawnSync('java', ['--version'], {encoding: 'utf8'}).status === 0;

function between(start, end) {
  const from = activity.indexOf(start);
  const to = activity.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, 'Native routing extraction markers remain present: ' + start);
  return activity.slice(from, to);
}

// Run the exact production capture, delivery, session-clear and bridge-guard methods.
// Android/WebView doubles allow independently delaying JS execution and its callback.
// The emitted JavaScript is also executed below in Node; no Android scheduling or
// actual renderer lifecycle behavior is claimed by this deterministic harness.
test('native route delivery deduplicates pending acknowledgments and isolates replacement/logout',
  {skip: javaAvailable ? false : 'JDK 17+ required for native routing harness'}, () => {
    const fields = between('    private String pendingSharedText;', '    @Override');
    const captures = between('    private void captureTicketIntent(', '    private void deliverPendingTicket(');
    const deliveries = between('    private void deliverPendingTicket(', '    @Override\n    protected void onNewIntent');
    const clear = between('    private boolean clearNativeSession(', '    private void scheduleNotificationJob(');
    const guard = between('        public boolean isPendingRouteCurrent(', '        @JavascriptInterface');
    const harness = `import java.util.*;import java.nio.charset.StandardCharsets;
public class NativeRoutingHarness {
  interface Callback { void result(String value); }
  static class Intent {
    static final String ACTION_SEND="send", EXTRA_SUBJECT="subject", EXTRA_TEXT="text";
    final Map<String,Object> extras=new HashMap<>();String action,type;
    String getAction(){return action;}String getType(){return type;}
    String getStringExtra(String key){return (String)extras.get(key);}
    CharSequence getCharSequenceExtra(String key){return (CharSequence)extras.get(key);}
    boolean getBooleanExtra(String key,boolean fallback){return (boolean)extras.getOrDefault(key,fallback);}
  }
  static class JSONObject {
    static String quote(String s){return "\\\""+s.replace("\\\\","\\\\\\\\").replace("\\\"","\\\\\\\"").replace("\\n","\\\\n")+"\\\"";}
  }
  static class NotificationDelivery { static void cancelPosted(Object context) {} }
  static class NotificationPollJob {static final String PREFS="test";static final int JOB_ID=42;}
  static class Preferences {String refresh="current";}
  static class NativeSessionState {
    static boolean clear(Preferences p,String token,boolean cas){if(cas&&!p.refresh.equals(token))return false;p.refresh="";return true;}
  }
  static class JobScheduler {int cancellations;void cancel(int id){cancellations++;}}
  static final int MODE_PRIVATE=0;static final String JOB_SCHEDULER_SERVICE="jobs";
  final Preferences prefs=new Preferences();final JobScheduler scheduler=new JobScheduler();
  Preferences getSharedPreferences(String name,int mode){return prefs;}
  Object getSystemService(String name){return scheduler;}
  ${fields}
  final AppBridge bridge=new AppBridge();final WebView webView=new WebView();
  class AppBridge {${guard}}
  class WebView {
    final List<Evaluation> queued=new ArrayList<>();
    void evaluateJavascript(String script,Callback callback){queued.add(new Evaluation(script,callback));}
  }
  class Evaluation {
    final String script,kind;final int generation;final Callback callback;int calls;
    Evaluation(String script,Callback callback){
      this.script=script;this.callback=callback;
      String marker="AndroidApp.isPendingRouteCurrent(\\\"";
      int start=script.indexOf(marker);check(start>=0,"Queued invocation must include native currency guard");start+=marker.length();
      int end=script.indexOf('"',start);kind=script.substring(start,end);
      generation=Integer.parseInt(script.substring(end+2,script.indexOf(')',end+2)));
    }
    String execute(boolean handlerAvailable){
      if(!bridge.isPendingRouteCurrent(kind,generation)||!handlerAvailable)return "false";
      calls++;return "true";
    }
    void acknowledge(String result){callback.result(result);}
  }
  ${captures}
  ${deliveries}
  ${clear}
  static Intent share(String text){Intent i=new Intent();i.action=Intent.ACTION_SEND;i.type="text/plain";i.extras.put(Intent.EXTRA_TEXT,text);return i;}
  static Intent ticket(String id){Intent i=new Intent();i.extras.put("ticket_id",id);return i;}
  static Intent inbox(){Intent i=new Intent();i.extras.put("notification_inbox",true);return i;}
  static void check(boolean ok,String why){if(!ok)throw new AssertionError(why);}
  Evaluation last(){return webView.queued.get(webView.queued.size()-1);}
  void shareNow(String text){captureShareIntent(share(text));deliverPendingShare();}
  void ticketNow(String id){captureTicketIntent(ticket(id));deliverPendingTicket();}
  static void emit(String kind,Evaluation evaluation){System.out.println("SCRIPT\\t"+kind+"\\t"+Base64.getEncoder().encodeToString(evaluation.script.getBytes(StandardCharsets.UTF_8)));}
  static void duplicateBeforeAck(){
    NativeRoutingHarness h=new NativeRoutingHarness();h.shareNow("Shared request");Evaluation share=h.last();
    h.deliverPendingShare();check(h.webView.queued.size()==1,"Share cannot queue twice before execution");
    String result=share.execute(true);h.deliverPendingShare();check(h.webView.queued.size()==1,"Share cannot queue twice before acknowledgment");
    share.acknowledge(result);check(h.pendingSharedText==null&&share.calls==1,"Share acknowledged exactly once");
    h.deliverPendingShare();check(h.webView.queued.size()==1,"Acknowledged share stays consumed");emit("share",share);
    h.ticketNow("ticket-1");Evaluation ticket=h.last();h.deliverPendingTicket();check(h.webView.queued.size()==2,"Ticket cannot queue twice");
    result=ticket.execute(true);h.deliverPendingTicket();check(h.webView.queued.size()==2,"Ticket remains in flight until ack");
    ticket.acknowledge(result);check(h.pendingTicketId==null&&ticket.calls==1,"Ticket acknowledged exactly once");emit("ticket",ticket);
    h.captureTicketIntent(inbox());h.deliverPendingTicket();Evaluation inbox=h.last();h.deliverPendingTicket();check(h.webView.queued.size()==3,"Inbox cannot queue twice");
    inbox.acknowledge(inbox.execute(true));check(!h.pendingNotificationInbox,"Inbox acknowledged");emit("inbox",inbox);
  }
  static void missingHandlerRetry(){
    for(String kind:List.of("share","ticket","inbox")){
      NativeRoutingHarness h=new NativeRoutingHarness();
      if(kind.equals("share"))h.shareNow("Retry share");else if(kind.equals("ticket"))h.ticketNow("retry-ticket");else{h.captureTicketIntent(inbox());h.deliverPendingTicket();}
      Evaluation first=h.last();first.acknowledge(first.execute(false));check(first.calls==0,"Missing handler cannot execute");
      if(kind.equals("share"))h.deliverPendingShare();else h.deliverPendingTicket();check(h.webView.queued.size()==2,"Missing handler keeps route retryable: "+kind);
      Evaluation second=h.last();second.acknowledge("null");
      if(kind.equals("share"))h.deliverPendingShare();else h.deliverPendingTicket();check(h.webView.queued.size()==3,"Null callback keeps route retryable: "+kind);
      Evaluation third=h.last();third.acknowledge(third.execute(true));check(third.calls==1,"Retry executes once: "+kind);
      check(h.pendingSharedText==null&&h.pendingTicketId==null&&!h.pendingNotificationInbox,"Retry consumes only successful route");
    }
  }
  static void unrelatedRoutes(){
    for(boolean shareFirst:List.of(false,true)){
      NativeRoutingHarness h=new NativeRoutingHarness();
      if(shareFirst){h.shareNow("Independent share");h.ticketNow("independent-ticket");}
      else{h.ticketNow("independent-ticket");h.shareNow("Independent share");}
      Evaluation first=h.webView.queued.get(0),second=h.webView.queued.get(1);
      check(h.bridge.isPendingRouteCurrent(first.kind,first.generation),"Unrelated route must not invalidate prior invocation");
      String firstResult=first.execute(true),secondResult=second.execute(true);
      second.acknowledge(secondResult);first.acknowledge(firstResult);
      h.deliverPendingShare();h.deliverPendingTicket();
      check(h.webView.queued.size()==2&&first.calls==1&&second.calls==1,"Independent routes each execute and clear once");
    }
  }
  static void newerRoute(){
    NativeRoutingHarness h=new NativeRoutingHarness();h.shareNow("Old share");Evaluation old=h.last();
    h.shareNow("New share");Evaluation newer=h.last();check(old.execute(true).equals("false"),"Superseded queued share cannot execute");
    old.acknowledge("true");check("New share".equals(h.pendingSharedText),"Stale positive ack cannot clear replacement share");
    h.deliverPendingShare();check(h.webView.queued.size()==2,"Stale ack cannot release replacement in-flight guard");
    newer.acknowledge(newer.execute(true));check(h.pendingSharedText==null,"Replacement share completes");
    h.ticketNow("old-ticket");old=h.last();h.captureTicketIntent(inbox());h.deliverPendingTicket();newer=h.last();
    check(old.execute(true).equals("false"),"Superseded ticket cannot execute after Inbox intent");old.acknowledge("true");
    check(h.pendingNotificationInbox,"Stale ticket ack cannot clear pending Inbox");h.deliverPendingTicket();check(h.webView.queued.size()==4,"Replacement Inbox stays in flight");
    newer.acknowledge(newer.execute(true));
    h.captureTicketIntent(inbox());h.deliverPendingTicket();old=h.last();h.ticketNow("new-ticket");newer=h.last();
    check(old.execute(true).equals("false"),"Superseded Inbox cannot execute after ticket intent");old.acknowledge("true");
    check("new-ticket".equals(h.pendingTicketId),"Stale Inbox ack cannot clear ticket");newer.acknowledge(newer.execute(true));
    check(h.pendingTicketId==null&&!h.pendingNotificationInbox,"Replacement ticket completes");
  }
  static void logoutStaleCallback(){
    NativeRoutingHarness h=new NativeRoutingHarness();h.shareNow("Old account share");Evaluation oldShare=h.last();h.ticketNow("old-account-ticket");Evaluation oldTicket=h.last();
    check(!h.clearNativeSession("stale",true),"Failed logout CAS remains rejected");
    check(h.scheduler.cancellations==0&&h.bridge.isPendingRouteCurrent(oldShare.kind,oldShare.generation)&&h.bridge.isPendingRouteCurrent(oldTicket.kind,oldTicket.generation),"Rejected logout preserves current pending routes");
    check(h.clearNativeSession("current",true),"Current logout succeeds");check(h.scheduler.cancellations==1,"Current logout cancels job");
    check(oldShare.execute(true).equals("false")&&oldTicket.execute(true).equals("false"),"Queued old-account routes are blocked after logout");
    h.shareNow("New account share");Evaluation newShare=h.last();h.ticketNow("new-account-ticket");Evaluation newTicket=h.last();
    oldShare.acknowledge("true");oldTicket.acknowledge("true");
    check("New account share".equals(h.pendingSharedText)&&"new-account-ticket".equals(h.pendingTicketId),"Late logout-era callbacks cannot clear new account routes");
    h.deliverPendingShare();h.deliverPendingTicket();check(h.webView.queued.size()==4,"Late callbacks cannot release new account in-flight guards");
    newShare.acknowledge(newShare.execute(true));newTicket.acknowledge(newTicket.execute(true));
    check(h.pendingSharedText==null&&h.pendingTicketId==null,"New account routes remain deliverable");
    check(!h.bridge.isPendingRouteCurrent("unknown",h.shareRouteGeneration),"Unknown route kinds are rejected");
  }
  public static void main(String[] args){duplicateBeforeAck();missingHandlerRetry();unrelatedRoutes();newerRoute();logoutStaleCallback();System.out.println("PASS native routing lifecycle harness");}
}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reportboss-native-routing-'));
    try {
      const file = path.join(dir, 'NativeRoutingHarness.java');
      fs.writeFileSync(file, harness);
      const result = spawnSync('java', [file], {encoding: 'utf8', timeout: 30000});
      assert.equal(result.status, 0, [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n'));
      assert.match(result.stdout, /PASS native routing lifecycle harness/);
      const scripts = result.stdout.split('\n').filter(line => line.startsWith('SCRIPT\t'));
      assert.equal(scripts.length, 3, 'All production route invocation variants are inspected');
      for (const line of scripts) {
        const [, kind, encoded] = line.split('\t');
        const script = Buffer.from(encoded, 'base64').toString('utf8');
        const handler = {share: 'receiveSharedText', ticket: 'receiveNotificationTicket', inbox: 'receiveNotificationInbox'}[kind];
        const expectedArgument = {share: 'Shared request', ticket: 'ticket-1', inbox: undefined}[kind];
        for (const current of [false, true]) for (const handlerAvailable of [false, true]) {
          const calls = [], guards = [];
          const context = {AndroidApp: {isPendingRouteCurrent(route, generation) {guards.push([route, generation]); return current;}}};
          context.window = context;
          if (handlerAvailable) context[handler] = (...args) => calls.push(args);
          const accepted = vm.runInNewContext(script, context);
          assert.equal(accepted, current && handlerAvailable, kind + ' acknowledges only a current route with a handler');
          assert.equal(guards.length, 1, kind + ' checks native currency before invoking JavaScript');
          assert.equal(guards[0][0], kind === 'share' ? 'share' : 'ticket');
          assert.equal(typeof guards[0][1], 'number');
          assert.equal(calls.length, accepted ? 1 : 0);
          if (accepted) assert.deepEqual(calls[0], expectedArgument === undefined ? [] : [expectedArgument]);
        }
      }
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
