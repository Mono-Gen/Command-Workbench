const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseIPv6,
  unwrapMapped,
  classifyAddress,
  canonicalAddress,
  classifyUdpTarget,
} = require('../../src/core/address-policy');

const INTERFACES = [
  { address: '10.0.0.5', netmask: '255.255.255.0' },
  { address: '127.0.0.1', netmask: '255.0.0.0' },
];

test('keeps the relay address classification table unchanged', () => {
  const allowed = {
    '127.0.0.1': 'loopback', '127.9.9.9': 'loopback', '::1': 'loopback', '::ffff:127.0.0.1': 'loopback',
    '10.0.0.3': 'private', '172.16.0.1': 'private', '172.31.255.255': 'private', '192.168.0.1': 'private',
    'fd12:3456::1': 'private', 'fc00::1': 'private', '::ffff:10.0.0.1': 'private', '::ffff:c0a8:0101': 'private',
  };
  for (const [ip, kind] of Object.entries(allowed)) assert.equal(classifyAddress(ip), kind, ip);
  const refused = ['8.8.8.8', '172.15.0.1', '172.32.0.1', '169.254.169.254', '0.0.0.0', '224.0.0.1',
    '255.255.255.255', '192.169.0.1', '::', 'fe80::1', 'ff02::1', '2001:db8::1', '::ffff:8.8.8.8',
    '::ffff:a9fe:a9fe', 'fe80::1%eth0', 'example.com', '', null, 5];
  for (const ip of refused) assert.equal(classifyAddress(ip), null, String(ip));
});

test('exports the moved IPv6 parsing and canonicalization helpers', () => {
  assert.deepEqual(parseIPv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(parseIPv6('::ffff:10.0.0.2'), [0, 0, 0, 0, 0, 0xffff, 0x0a00, 0x0002]);
  assert.equal(parseIPv6('fe80::1%eth0'), null);
  assert.equal(unwrapMapped('::ffff:10.0.0.2'), '10.0.0.2');
  assert.equal(unwrapMapped('2001:db8::1'), '2001:db8::1');
  assert.equal(canonicalAddress('::ffff:0a00:0001'), '10.0.0.1');
  assert.equal(canonicalAddress('2001:db8::1'), '8193:3512:0:0:0:0:0:1');
  assert.equal(canonicalAddress('example.com'), 'example.com');
});

test('classifies every specified UDP target vector in policy order', () => {
  const cases = [
    ['10.0.0.20', { ok: true, kind: 'private' }],
    ['127.0.0.1', { ok: true, kind: 'loopback' }],
    ['127.5.5.5', { ok: true, kind: 'loopback' }],
    ['10.0.0.255', { ok: false, code: 'directed_broadcast' }],
    ['10.0.0.0', { ok: true, kind: 'private' }],
    ['127.255.255.255', { ok: false, code: 'directed_broadcast' }],
    ['172.16.5.255', { ok: true, kind: 'private' }],
    ['8.8.8.8', { ok: false, code: 'target_not_allowed' }],
    ['192.0.2.1', { ok: false, code: 'target_not_allowed' }],
    ['169.254.169.254', { ok: false, code: 'link_local' }],
    ['224.0.0.1', { ok: false, code: 'multicast' }],
    ['239.255.255.250', { ok: false, code: 'multicast' }],
    ['240.0.0.1', { ok: false, code: 'target_not_allowed' }],
    ['0.0.0.0', { ok: false, code: 'unspecified' }],
    ['255.255.255.255', { ok: false, code: 'limited_broadcast' }],
    ['::1', { ok: false, code: 'not_ipv4' }],
    ['::ffff:10.0.0.1', { ok: false, code: 'not_ipv4' }],
    ['localhost', { ok: false, code: 'not_ipv4' }],
    ['010.0.0.1', { ok: false, code: 'not_ipv4' }],
    ['10.0.0.256', { ok: false, code: 'not_ipv4' }],
    ['', { ok: false, code: 'not_ipv4' }],
    [null, { ok: false, code: 'not_ipv4' }],
    [5, { ok: false, code: 'not_ipv4' }],
  ];
  for (const [address, expected] of cases) {
    assert.deepEqual(classifyUdpTarget(address, { interfaces: INTERFACES }), expected, String(address));
  }
});

test('uses exact interface broadcasts and skips /31 and /32 interfaces', () => {
  const slash23 = [{ address: '172.16.5.9', netmask: '255.255.254.0' }];
  assert.deepEqual(classifyUdpTarget('172.16.5.255', { interfaces: slash23 }), {
    ok: false, code: 'directed_broadcast',
  });
  assert.deepEqual(classifyUdpTarget('172.16.4.255', { interfaces: slash23 }), {
    ok: true, kind: 'private',
  });
  for (const netmask of ['255.255.255.254', '255.255.255.255']) {
    const interfaces = [{ address: '10.0.0.5', netmask }];
    assert.deepEqual(classifyUdpTarget('10.0.0.7', { interfaces }), { ok: true, kind: 'private' });
  }
});

test('ignores garbage interfaces without throwing or mutation', () => {
  const interfaces = [
    null,
    {},
    { address: '10.0.0.5' },
    { address: 'bad', netmask: '255.255.255.0' },
    { address: '10.0.0.5', netmask: '255.0.255.0' },
    { address: '010.0.0.5', netmask: '255.255.255.0' },
  ];
  const before = JSON.stringify(interfaces);
  assert.deepEqual(classifyUdpTarget('10.0.0.255', { interfaces }), { ok: true, kind: 'private' });
  assert.equal(JSON.stringify(interfaces), before);
  assert.deepEqual(classifyUdpTarget('10.0.0.20', { interfaces }), classifyUdpTarget('10.0.0.20', { interfaces }));
});

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function parseStrictIPv4(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value)) return null;
  const octets = value.split('.').map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function ipv4Number(octets) {
  return octets.reduce((value, octet) => ((value << 8) | octet) >>> 0, 0);
}

test('2000 seeded dotted quads never throw and only allow safe private targets', () => {
  const next = seeded(0x8e17c3a5);
  const masks = [8, 16, 23, 24, 30];
  const interfaces = Array.from({ length: 64 }, () => {
    const address = `10.${next() & 255}.${next() & 255}.${1 + (next() % 253)}`;
    const prefix = masks[next() % masks.length];
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const netmask = [24, 16, 8, 0].map((shift) => (mask >>> shift) & 255).join('.');
    return { address, netmask };
  });
  const broadcasts = new Set(interfaces.map((entry) => {
    const ip = ipv4Number(parseStrictIPv4(entry.address));
    const mask = ipv4Number(parseStrictIPv4(entry.netmask));
    const value = (ip | (~mask >>> 0)) >>> 0;
    return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
  }));
  const before = JSON.stringify(interfaces);

  for (let run = 0; run < 2000; run += 1) {
    const octets = Array.from({ length: 4 }, () => next() % 300);
    const mode = run % 4;
    let candidate;
    if (mode === 0) candidate = octets.join('.');
    else if (mode === 1) candidate = `0${octets[0]}.${octets.slice(1).join('.')}`;
    else if (mode === 2) candidate = `${octets[0]}.${octets[1]}.256.${octets[3]}`;
    else candidate = `${octets[0]}..${octets[2]}.${octets[3]}`;
    const result = classifyUdpTarget(candidate, { interfaces });
    if (result.ok) {
      const parsed = parseStrictIPv4(candidate);
      assert.notEqual(parsed, null, `strict IPv4 run ${run}`);
      const [a, b] = parsed;
      const safe = a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168);
      assert.equal(safe, true, `private or loopback run ${run}`);
      assert.equal(broadcasts.has(candidate), false, `not a broadcast run ${run}`);
    }
  }
  assert.equal(JSON.stringify(interfaces), before);
});
