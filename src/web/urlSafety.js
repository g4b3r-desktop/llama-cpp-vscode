const dns = require('dns').promises;
const net = require('net');

const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.amazonaws.com',
  'instance-data',
  'instance-data.ec2.internal'
]);

function normalizeHttpUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); }
  catch { throw new Error('Invalid URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http:// and https:// URLs are allowed.');
  if (url.username || url.password) throw new Error('URLs containing credentials are not allowed.');
  if (!url.hostname) throw new Error('URL hostname is required.');
  url.hash = '';
  return url;
}

async function assertPublicUrl(value, options = {}) {
  const url = normalizeHttpUrl(value);
  const hostname = canonicalHost(url.hostname);
  assertDomainPolicy(hostname, options.allowDomains || [], options.blockDomains || []);
  if (isBlockedHostname(hostname)) throw new Error(`Blocked web host: ${hostname}`);
  const addresses = await resolveHost(hostname);
  if (!addresses.length) throw new Error(`Could not resolve host: ${hostname}`);
  for (const entry of addresses) {
    if (isPrivateOrReservedIp(entry.address)) throw new Error(`Blocked private/reserved address for ${hostname}: ${entry.address}`);
  }
  return { url, addresses };
}

async function resolveHost(hostname) {
  if (net.isIP(hostname)) return [{ address: hostname, family: net.isIP(hostname) }];
  return dns.lookup(hostname, { all: true, verbatim: true });
}

function assertDomainPolicy(hostname, allowDomains, blockDomains) {
  const allow = normalizeDomainList(allowDomains);
  const block = normalizeDomainList(blockDomains);
  if (block.some(domain => domainMatches(hostname, domain))) throw new Error(`Domain is blocked by settings: ${hostname}`);
  if (allow.length && !allow.some(domain => domainMatches(hostname, domain))) throw new Error(`Domain is not in llamaCpp.agent.web.allowedDomains: ${hostname}`);
}

function normalizeDomainList(values) {
  return (Array.isArray(values) ? values : []).map(value => canonicalHost(String(value).replace(/^https?:\/\//i, '').split('/')[0])).filter(Boolean);
}

function domainMatches(hostname, domain) {
  const host = canonicalHost(hostname);
  const rule = canonicalHost(domain).replace(/^\*\./, '');
  return Boolean(rule) && (host === rule || host.endsWith(`.${rule}`));
}

function canonicalHost(host) { return String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''); }
function isBlockedHostname(host) { const h = canonicalHost(host); return BLOCKED_HOSTS.has(h) || h.endsWith('.localhost') || h.endsWith('.local'); }

function isPrivateOrReservedIp(address) {
  const ip = canonicalHost(address);
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true;
}

function isBlockedIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a,b,c,d] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  if (a === 255 && b === 255 && c === 255 && d === 255) return true;
  return false;
}

function isBlockedIpv6(ip) {
  const value = ip.toLowerCase();
  if (value === '::' || value === '::1') return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(value)) return true;
  if (value.startsWith('ff')) return true;
  if (value.startsWith('2001:db8:') || value === '2001:db8::') return true;
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  return false;
}

module.exports = { normalizeHttpUrl, assertPublicUrl, resolveHost, domainMatches, isBlockedHostname, isPrivateOrReservedIp, isBlockedIpv4, isBlockedIpv6 };
