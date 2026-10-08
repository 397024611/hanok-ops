const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifyCertificate } = require('../scripts/verify-apk-certificate.cjs');
const expected = 'fd9dcc1f8ddcc0a600e93cc0ebfb17ad53b98eac23df06a8f0b828b3bf5e6a4f';
const header = 'Verifies\nNumber of signers: 1\n';

test('APK certificate verifier accepts classic apksigner signer labels', () => {
  assert.equal(verifyCertificate(header + 'Signer #1 certificate SHA-256 digest: ' + expected, expected), expected);
});
test('APK certificate verifier accepts current per-scheme labels and identical scheme certificates', () => {
  assert.equal(verifyCertificate(header + 'V2 Signer: certificate SHA-256 digest: ' + expected + '\nV3.1 Signer: certificate SHA-256 digest: ' + expected.toUpperCase(), expected), expected);
});
test('APK certificate verifier rejects a different or mixed signer certificate', () => {
  const wrong = '0'.repeat(64);
  assert.throws(() => verifyCertificate(header + 'V2 Signer: certificate SHA-256 digest: ' + wrong, expected), /does not match/);
  assert.throws(() => verifyCertificate(header + 'V2 Signer: certificate SHA-256 digest: ' + expected + '\nV3 Signer: certificate SHA-256 digest: ' + wrong, expected), /does not match/);
});
test('APK certificate verifier fails closed on missing certificate or multiple signers', () => {
  assert.throws(() => verifyCertificate(header + 'V2 Signer: public key SHA-256 digest: ' + expected, expected), /does not match/);
  assert.throws(() => verifyCertificate(header + 'V2 Signer: certificate SHA-256 digest: ' + expected + '\nUnknown label certificate SHA-256 digest: ' + expected, expected), /does not match/);
  assert.throws(() => verifyCertificate('Number of signers: 2\nSigner #1 certificate SHA-256 digest: ' + expected, expected), /exactly one/);
  assert.throws(() => verifyCertificate(header + 'Number of signers: 2\nV2 Signer: certificate SHA-256 digest: ' + expected, expected), /exactly one/);
  assert.throws(() => verifyCertificate(header + 'Signer #2 certificate SHA-256 digest: ' + expected, expected), /does not match/);
  assert.throws(() => verifyCertificate(header + 'V999 Signer: certificate SHA-256 digest: ' + expected, expected), /does not match/);
  assert.throws(() => verifyCertificate(header + 'V2 Signer: certificate SHA-256 digest: ' + expected + '\nUnknown Certificate SHA-256 digest: ' + '0'.repeat(64), expected), /does not match/);
});
test('APK certificate verifier validates the expected fingerprint and accepts CRLF', () => {
  assert.throws(() => verifyCertificate(header, ''), /Invalid expected/);
  assert.equal(verifyCertificate('Number of signers: 1\r\nV2 Signer: certificate SHA-256 digest: ' + expected + '\r\n', expected), expected);
});
