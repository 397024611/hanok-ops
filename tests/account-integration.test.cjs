const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('integration endpoint guards fail closed before any network or Docker action', async () => {
  const { requireLoopback, rejectRemoteEnvironment } = await import('./account-integration.mjs');
  for (const address of ['https://example.supabase.co', 'http://192.168.1.2:54321', 'http://127.0.0.1.evil.test:54321', 'http://127.0.0.1:80', 'http://user:secret@127.0.0.1:54321', 'http://127.0.0.1:54321/?redirect=https://example.test']) {
    assert.throws(() => requireLoopback(address, 'API'));
  }
  for (const address of ['postgresql://postgres:fixture@example.supabase.co:54322/postgres', 'postgresql://postgres@127.0.0.1:5432/postgres', 'https://127.0.0.1:54322/postgres']) {
    assert.throws(() => requireLoopback(address, 'DB'));
  }
  assert.equal(requireLoopback('http://127.0.0.1:54321', 'API').hostname, '127.0.0.1');
  assert.equal(requireLoopback('postgresql://postgres:fixture@127.0.0.1:54322/postgres', 'DB').port, '54322');
  assert.throws(() => rejectRemoteEnvironment({ SUPABASE_ACCESS_TOKEN: 'placeholder' }));
  assert.throws(() => rejectRemoteEnvironment({ DATABASE_URL: 'postgresql://example.test/postgres' }));
  assert.doesNotThrow(() => rejectRemoteEnvironment({}));
});

test('integration workflow is read-only, pinned, isolated, and does not export private artifacts', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/account-integration.yml'), 'utf8');
  assert.match(workflow, /pull_request:/);
  assert.doesNotMatch(workflow, /pull_request_target|secrets\.|upload-artifact|--linked|db push|functions deploy/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /supabase@2\.120\.0/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /--project-id reportboss-accounts-integration --no-backup/);
  const config = fs.readFileSync(path.join(__dirname, '../supabase/config.toml'), 'utf8');
  assert.match(config, /\[functions.ops-admin-accounts\]\nverify_jwt = true/);
  assert.match(config, /\[functions.ops-admin-store-user\]\nverify_jwt = true/);
  assert.match(config, /\[local_smtp\]\nenabled = false/);
});
