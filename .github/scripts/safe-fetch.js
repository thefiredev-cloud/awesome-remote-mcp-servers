'use strict';
// SSRF-guarded HTTPS client for probing contributor-supplied URLs from CI.
//
// Guarantees (each enforced on the first request and on every redirect hop):
//   1. https only, no userinfo, port 443 only.
//   2. The host must be a DNS name. IP literals (including decimal/hex/octal
//      forms, which the URL parser normalises to dotted form) are rejected.
//   3. Reserved suffixes (.local, .internal, .localhost, ...) are rejected.
//   4. Every address the name resolves to must be a public unicast address.
//      One private/loopback/link-local/metadata address in the set rejects the
//      whole name, so a mixed answer cannot be used to smuggle a private target.
//   5. The check and the connect use the SAME lookup call: the socket is opened
//      to the address that was validated, so there is no re-resolution window
//      for DNS rebinding.
//   6. Redirects are followed manually (max 3) and each Location is re-validated
//      from step 1. Response bodies are capped.

const dns = require('node:dns');
const net = require('node:net');
const https = require('node:https');

const BLOCKED_SUFFIXES = [
  'localhost', 'local', 'internal', 'localdomain', 'lan', 'home', 'corp',
  'intranet', 'private', 'arpa', 'test', 'invalid',
];

// [network, prefix length]
const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function v4ToInt(ip) {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function isPublicIPv4(ip) {
  if (net.isIPv4(ip) === false) return false;
  const n = v4ToInt(ip);
  for (const [base, bits] of BLOCKED_V4) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((n & mask) >>> 0 === (v4ToInt(base) & mask) >>> 0) return false;
  }
  return true;
}

// Expand an IPv6 text address into eight 16-bit groups.
function parseIPv6(ip) {
  let s = ip.split('%')[0];
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const n = v4ToInt(tail[1]);
    s = s.slice(0, -tail[1].length) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const halves = s.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length > 1 ? new Array(8 - head.length - rest.length).fill('0') : [];
  const groups = [...head, ...fill, ...rest].map(g => parseInt(g, 16));
  if (groups.length !== 8 || groups.some(g => Number.isNaN(g))) throw new Error(`bad IPv6 ${ip}`);
  return groups;
}

function isPublicIPv6(ip) {
  const g = parseIPv6(ip);
  // IPv4-mapped (::ffff:a.b.c.d): judge the embedded IPv4 address.
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) {
    return isPublicIPv4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  }
  // Allowlist: global unicast 2000::/3 only.
  if ((g[0] & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && g[1] < 0x200) return false; // 2001::/23 protocol assignments, Teredo
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2002) return false; // 6to4 embeds an IPv4 address
  if (g[0] === 0x3fff && (g[1] & 0xf000) === 0) return false; // documentation 3fff::/20
  return true;
}

function isPublicAddress(addr) {
  if (net.isIPv4(addr)) return isPublicIPv4(addr);
  if (net.isIPv6(addr)) return isPublicIPv6(addr);
  return false;
}

// Throws unless `raw` is an acceptable probe target. Returns the parsed URL.
function checkUrl(raw, { allowHosts } = {}) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('invalid URL'); }
  if (u.protocol !== 'https:') throw new Error('only https is allowed');
  if (u.username || u.password) throw new Error('credentials in URL are not allowed');
  if (u.port && u.port !== '443') throw new Error('only port 443 is allowed');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (net.isIP(host.replace(/^\[|\]$/g, '')) !== 0) throw new Error('IP literal hosts are not allowed');
  if (!host.includes('.')) throw new Error('host must be a fully qualified DNS name');
  if (BLOCKED_SUFFIXES.some(sfx => host === sfx || host.endsWith(`.${sfx}`))) throw new Error('reserved host suffix');
  if (allowHosts && !allowHosts.includes(host)) throw new Error('host is not on the allowlist');
  return u;
}

// net/tls compatible `lookup` that refuses non-public answers. The resolver is
// injectable for tests; the default is the system resolver.
function makeGuardedLookup(resolver = (h) => dns.promises.lookup(h, { all: true, verbatim: true })) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    (async () => {
      const addrs = await resolver(hostname);
      if (!addrs || addrs.length === 0) throw new Error(`no address for ${hostname}`);
      const bad = addrs.find(a => !isPublicAddress(a.address));
      if (bad) {
        const err = new Error(`blocked non-public address for ${hostname}`);
        err.code = 'EBLOCKED';
        throw err;
      }
      return addrs;
    })().then(
      addrs => (options && options.all
        ? callback(null, addrs)
        : callback(null, addrs[0].address, addrs[0].family)),
      err => callback(err),
    );
  };
}

function once(u, { method, headers, body, maxBytes, timeoutMs, lookup, transport }) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body != null) h['Content-Length'] = Buffer.byteLength(body);
    const req = transport({
      protocol: 'https:',
      hostname: u.hostname,
      port: 443,
      path: `${u.pathname}${u.search}`,
      method,
      headers: h,
      lookup,
      agent: false,
    }, (res) => {
      const chunks = [];
      let size = 0;
      const finish = () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') });
      };
      res.on('data', (c) => {
        size += c.length;
        chunks.push(size > maxBytes ? c.subarray(0, c.length - (size - maxBytes)) : c);
        if (size >= maxBytes) { res.destroy(); finish(); }
      });
      res.on('end', finish);
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    if (body != null) req.write(body);
    req.end();
  });
}

async function guardedRequest(rawUrl, opts = {}) {
  const {
    method = 'GET', headers = {}, body = null, maxBytes = 20000, timeoutMs = 20000,
    maxRedirects = 3, allowHosts, lookup = makeGuardedLookup(), transport = https.request,
  } = opts;
  let current = checkUrl(rawUrl, { allowHosts });
  let m = method;
  let b = body;
  for (let hop = 0; ; hop++) {
    const res = await once(current, { method: m, headers, body: b, maxBytes, timeoutMs, lookup, transport });
    const loc = res.headers && res.headers.location;
    if ([301, 302, 303, 307, 308].includes(res.status) && loc) {
      if (hop >= maxRedirects) throw new Error('too many redirects');
      current = checkUrl(new URL(loc, current).toString(), { allowHosts });
      if (res.status !== 307 && res.status !== 308 && m !== 'GET' && m !== 'HEAD') { m = 'GET'; b = null; }
      continue;
    }
    return { ...res, url: current.toString() };
  }
}

module.exports = { isPublicAddress, checkUrl, makeGuardedLookup, guardedRequest };
