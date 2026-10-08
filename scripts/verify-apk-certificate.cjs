const fs = require('node:fs');

function verifyCertificate(output, expected) {
  expected = String(expected || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('Invalid expected certificate fingerprint');
  const outputLines = output.split(/\r?\n/).map(line => line.trim());
  const signerCounts = outputLines.filter(line => /^Number of signers:/i.test(line));
  if (signerCounts.length !== 1 || !/^Number of signers: 1$/i.test(signerCounts[0])) throw new Error('APK must have exactly one signer');
  const lines = outputLines.filter(line => /certificate SHA-256 digest:/i.test(line));
  const digests = lines.map(line => line.match(/^(?:Signer #1|V(?:1|2|3|3\.1|3\.2|4) Signer):? certificate SHA-256 digest: ([0-9a-f]{64})$/i)?.[1]?.toLowerCase());
  if (!digests.length || digests.some(digest => digest !== expected)) {
    throw new Error('APK certificate fingerprint does not match the approved release identity');
  }
  return expected;
}

if (require.main === module) {
  try {
    const fingerprint = verifyCertificate(fs.readFileSync(process.argv[2], 'utf8'), process.argv[3]);
    console.log('Approved APK certificate SHA-256: ' + fingerprint);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { verifyCertificate };
