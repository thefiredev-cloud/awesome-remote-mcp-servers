'use strict';
// Run: node --test .github/scripts/safe-fetch.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { isPublicAddress, checkUrl, makeGuardedLookup, guardedRequest } = require('./safe-fetch.js');

test('public addresses pass', () => {
  for (const a of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1',
    '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
    assert.equal(isPublicAddress(a), true, a);
  }
});

test('private, loopback, link-local, metadata and reserved addresses are blocked', () => {
  for (const a of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '127.255.255.254', '169.254.169.254',
    '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.168.1.1', '198.18.0.1', '198.19.255.255', '203.0.113.9',
    '224.0.0.1', '240.0.0.1', '255.255.255.255', '100.100.100.200',
    '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', 'fec0::1', '2001:db8::1', '2002:7f00:1::',
    '64:ff9b::7f00:1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:10.0.0.1',
    'fd00:ec2::254', 'not-an-ip', '']) {
    assert.equal(isPublicAddress(a), false, a);
  }
});

test('checkUrl accepts plain https DNS names', () => {
  assert.equal(checkUrl('https://mcp.example.com/mcp').hostname, 'mcp.example.com');
  assert.equal(checkUrl('https://mcp.example.com:443/mcp?x=1').pathname, '/mcp');
});

test('checkUrl rejects unsafe URLs', () => {
  for (const u of [
    'http://mcp.example.com/', 'ftp://mcp.example.com/', 'file:///etc/passwd', 'javascript:alert(1)',
    'https://user:pw@mcp.example.com/', 'https://mcp.example.com:8443/', 'https://mcp.example.com:80/',
    'https://127.0.0.1/', 'https://169.254.169.254/latest/meta-data/', 'https://2130706433/', 'https://0x7f000001/',
    'https://0177.0.0.1/', 'https://[::1]/', 'https://[::ffff:7f00:1]/', 'https://10.0.0.5/',
    'https://localhost/', 'https://localhost./', 'https://metadata.google.internal/', 'https://printer.local/',
    'https://intranet/', 'https://foo.localhost/', 'https://x.arpa/', 'not a url', '',
  ]) {
    assert.throws(() => checkUrl(u), undefined, u);
  }
});

test('checkUrl allowHosts restricts the host', () => {
  assert.doesNotThrow(() => checkUrl('https://glama.ai/x', { allowHosts: ['glama.ai'] }));
  assert.throws(() => checkUrl('https://evil.example.com/x', { allowHosts: ['glama.ai'] }));
});

function lookupOf(addrs) {
  const l = makeGuardedLookup(async () => addrs);
  return (opts) => new Promise((resolve, reject) => l('evil.example.com', opts, (err, a, f) => (err ? reject(err) : resolve([a, f]))));
}

test('guarded lookup refuses private answers and mixed answers (rebinding set)', async () => {
  await assert.rejects(lookupOf([{ address: '127.0.0.1', family: 4 }])({}), /blocked/);
  await assert.rejects(lookupOf([{ address: '169.254.169.254', family: 4 }])({}), /blocked/);
  await assert.rejects(lookupOf([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }])({}), /blocked/);
  await assert.rejects(lookupOf([{ address: '8.8.8.8', family: 4 }, { address: '::1', family: 6 }])({ all: true }), /blocked/);
  await assert.rejects(lookupOf([])({}), /no address/);
});

test('guarded lookup returns validated public answers in both call shapes', async () => {
  const one = await lookupOf([{ address: '8.8.8.8', family: 4 }])({});
  assert.deepEqual(one, ['8.8.8.8', 4]);
  const l = makeGuardedLookup(async () => [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }]);
  const all = await new Promise((res, rej) => l('x.example.com', { all: true }, (e, a) => (e ? rej(e) : res(a))));
  assert.equal(all.length, 2);
});

// A fake https.request that "connects" through the supplied lookup, like the
// real socket does, then answers with the scripted response.
function fakeTransport(script) {
  const calls = [];
  const transport = (opts, onResponse) => {
    calls.push(opts);
    const handlers = {};
    const req = {
      on(ev, fn) { handlers[ev] = fn; return req; },
      write() {}, destroy(e) { if (handlers.error) handlers.error(e); },
      end() {
        opts.lookup(opts.hostname, {}, (err) => {
          if (err) return handlers.error(err);
          const r = script(opts);
          const res = {
            statusCode: r.status, headers: r.headers || {},
            on(ev, fn) {
              if (ev === 'data') setImmediate(() => { fn(Buffer.from(r.body || '')); });
              if (ev === 'end') setImmediate(() => setImmediate(fn));
              return res;
            },
            destroy() {},
          };
          onResponse(res);
        });
      },
    };
    return req;
  };
  return { transport, calls };
}

test('request to a name that resolves to a private address never connects', async () => {
  const { transport, calls } = fakeTransport(() => ({ status: 200, body: '{}' }));
  const lookup = makeGuardedLookup(async () => [{ address: '169.254.169.254', family: 4 }]);
  await assert.rejects(guardedRequest('https://rebind.example.com/mcp', { transport, lookup }), /blocked/);
  assert.equal(calls.length, 1);
});

test('redirect to a private-resolving host is blocked, redirect to an IP literal is blocked', async () => {
  const lookup = makeGuardedLookup(async (h) => (h === 'ok.example.com'
    ? [{ address: '8.8.8.8', family: 4 }] : [{ address: '10.0.0.7', family: 4 }]));
  let t = fakeTransport((o) => (o.hostname === 'ok.example.com'
    ? { status: 302, headers: { location: 'https://internal-alias.example.com/x' } } : { status: 200, body: 'secret' }));
  await assert.rejects(guardedRequest('https://ok.example.com/', { transport: t.transport, lookup }), /blocked/);

  t = fakeTransport(() => ({ status: 307, headers: { location: 'https://169.254.169.254/latest/meta-data/' } }));
  await assert.rejects(guardedRequest('https://ok.example.com/', { transport: t.transport, lookup }), /IP literal/);

  t = fakeTransport(() => ({ status: 302, headers: { location: 'http://ok.example.com/' } }));
  await assert.rejects(guardedRequest('https://ok.example.com/', { transport: t.transport, lookup }), /only https/);

  t = fakeTransport(() => ({ status: 302, headers: { location: 'https://ok.example.com:8080/' } }));
  await assert.rejects(guardedRequest('https://ok.example.com/', { transport: t.transport, lookup }), /port 443/);
});

test('redirect loops stop after 3 hops; safe redirect chain succeeds', async () => {
  const lookup = makeGuardedLookup(async () => [{ address: '8.8.8.8', family: 4 }]);
  let t = fakeTransport(() => ({ status: 302, headers: { location: 'https://ok.example.com/again' } }));
  await assert.rejects(guardedRequest('https://ok.example.com/', { transport: t.transport, lookup }), /too many redirects/);

  let n = 0;
  t = fakeTransport(() => (n++ === 0
    ? { status: 307, headers: { location: '/final' } } : { status: 200, body: '{"result":{}}' }));
  const res = await guardedRequest('https://ok.example.com/start', { method: 'POST', body: '{}', transport: t.transport, lookup });
  assert.equal(res.status, 200);
  assert.equal(res.url, 'https://ok.example.com/final');
  assert.equal(t.calls[1].method, 'POST'); // 307 keeps the method
});

test('allowHosts blocks a redirect off the allowed host', async () => {
  const lookup = makeGuardedLookup(async () => [{ address: '8.8.8.8', family: 4 }]);
  const t = fakeTransport(() => ({ status: 302, headers: { location: 'https://evil.example.com/' } }));
  await assert.rejects(guardedRequest('https://glama.ai/x', { transport: t.transport, lookup, allowHosts: ['glama.ai'] }), /allowlist/);
});
