const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeHttpUrl, domainMatches, isBlockedHostname, isPrivateOrReservedIp } = require('../src/web/urlSafety');

test('normalizeHttpUrl accepts public http(s) URLs and rejects unsafe schemes/credentials', () => {
  assert.equal(normalizeHttpUrl('https://example.com/docs#x').toString(), 'https://example.com/docs');
  assert.throws(() => normalizeHttpUrl('file:///etc/passwd'), /Only http/);
  assert.throws(() => normalizeHttpUrl('https://user:pass@example.com/'), /credentials/);
});

test('domain policy helper matches exact hosts and subdomains', () => {
  assert.equal(domainMatches('docs.example.com', 'example.com'), true);
  assert.equal(domainMatches('example.com', '*.example.com'), true);
  assert.equal(domainMatches('evil-example.com', 'example.com'), false);
});

test('blocked hostnames include localhost and metadata endpoints', () => {
  assert.equal(isBlockedHostname('localhost'), true);
  assert.equal(isBlockedHostname('api.localhost'), true);
  assert.equal(isBlockedHostname('metadata.google.internal'), true);
  assert.equal(isBlockedHostname('example.com'), false);
});

test('private, loopback, link-local and reserved IPs are rejected', () => {
  for (const ip of ['127.0.0.1','10.0.0.1','172.16.2.3','192.168.1.2','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','::1','fd00::1','fe80::1','2001:db8::1']) {
    assert.equal(isPrivateOrReservedIp(ip), true, ip);
  }
  assert.equal(isPrivateOrReservedIp('8.8.8.8'), false);
  assert.equal(isPrivateOrReservedIp('2606:4700:4700::1111'), false);
});
