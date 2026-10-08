const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const manifest = fs.readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
const activity = fs.readFileSync('android/app/src/main/java/com/hanokgroup/ops/MainActivity.java', 'utf8');

// Source-contract guards. These do not replace a device-level login smoke test.
test('Android network-constrained background jobs declare the install-time permission', () => {
  assert.match(activity, /\.setRequiredNetworkType\(JobInfo\.NETWORK_TYPE_ANY\)/);
  assert.match(manifest, /<uses-permission\s+android:name="android\.permission\.ACCESS_NETWORK_STATE"\s*\/>/);
});

test('Android persisted notification job retains its required service and boot permission', () => {
  assert.match(manifest, /<uses-permission\s+android:name="android\.permission\.RECEIVE_BOOT_COMPLETED"\s*\/>/);
  assert.match(manifest, /<service\s+android:name="\.NotificationPollJob"\s+android:permission="android\.permission\.BIND_JOB_SERVICE"\s+android:exported="false"\s*\/>/);
});

test('Android auxiliary scheduling failure cannot propagate out of login session sync', () => {
  const method = activity.slice(activity.indexOf('    private void scheduleNotificationJob() {'), activity.indexOf('    private String storedNativeSession()'));
  assert.match(method, /try\s*\{[\s\S]*scheduler\.schedule\(info\)[\s\S]*\}\s*catch\s*\(RuntimeException e\)/);
  assert.match(method, /scheduler\.schedule\(info\) != JobScheduler\.RESULT_SUCCESS/);
  assert.doesNotMatch(method, /throw\s/);
});

test('Android upgrade identity, displayed version and signed-workflow guard stay aligned', () => {
  const gradle = fs.readFileSync('android/app/build.gradle', 'utf8');
  const workflow = fs.readFileSync('.github/workflows/release-baogao-laoban.yml', 'utf8');
  const html = fs.readFileSync('android/app/src/main/assets/index.html', 'utf8');
  const code = Number(gradle.match(/versionCode (\d+)/)[1]);
  const version = gradle.match(/versionName '([^']+)'/)[1];
  assert.match(gradle, /applicationId 'com\.hanokgroup\.ops'/);
  assert.ok(code > 11, 'Hotfix must update the delivered code 11 APK');
  assert.ok(workflow.includes("versionCode='" + code + "' versionName='" + version + "'"));
  assert.ok(html.includes('· v' + version));
  assert.ok(workflow.includes('cc4e046b6cec589ac00310ee4ea8f62506cfd45a44114e15c23875f4fdd9f92f'));
});
