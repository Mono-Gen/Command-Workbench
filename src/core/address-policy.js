const net = require('node:net');

function parseIPv6(ip) {
  if (!net.isIPv6(ip) || ip.includes('%')) return null;
  let text = ip;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const all = halves.length > 1 ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head;
  const numbers = all.map((h) => Number.parseInt(h, 16));
  return numbers.length === 8 && numbers.every(Number.isFinite) ? numbers : null;
}

// An IPv6 address that only wraps an IPv4 one (::ffff:a.b.c.d) is judged as the IPv4 address.
function unwrapMapped(ip) {
  const groups = parseIPv6(ip);
  if (groups && groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  }
  return ip;
}

// 'loopback' | 'private' | null (not allowed: public, link-local, multicast, unspecified, ...).
function classifyAddress(ip) {
  if (typeof ip !== 'string') return null;
  const address = unwrapMapped(ip);
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    if (a === 127) return 'loopback';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
    return null;
  }
  const groups = parseIPv6(address);
  if (groups === null) return null;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return 'loopback';
  if ((groups[0] & 0xfe00) === 0xfc00) return 'private';
  return null;
}

function canonicalAddress(ip) {
  const address = unwrapMapped(ip);
  const groups = net.isIPv6(address) ? parseIPv6(address) : null;
  return groups ? groups.join(':') : address;
}

function parseIPv4(ip) {
  if (typeof ip !== 'string' || !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(ip)) {
    return null;
  }
  const octets = ip.split('.').map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function ipv4Number(octets) {
  return octets.reduce((value, octet) => ((value << 8) | octet) >>> 0, 0);
}

function interfaceBroadcast(entry) {
  if (entry === null || typeof entry !== 'object') return null;
  const address = parseIPv4(entry.address);
  const netmask = parseIPv4(entry.netmask);
  if (address === null || netmask === null) return null;
  const bits = netmask.map((octet) => octet.toString(2).padStart(8, '0')).join('');
  if (!/^1*0*$/.test(bits)) return null;
  const prefix = bits.indexOf('0') === -1 ? 32 : bits.indexOf('0');
  if (prefix >= 31) return null;
  const addressValue = ipv4Number(address);
  const maskValue = ipv4Number(netmask);
  return (addressValue | (~maskValue >>> 0)) >>> 0;
}

function classifyUdpTarget(address, { interfaces = [] } = {}) {
  const octets = parseIPv4(address);
  if (octets === null) return { ok: false, code: 'not_ipv4' };
  if (address === '0.0.0.0') return { ok: false, code: 'unspecified' };
  if (address === '255.255.255.255') return { ok: false, code: 'limited_broadcast' };
  if (octets[0] >= 224 && octets[0] <= 239) return { ok: false, code: 'multicast' };

  const target = ipv4Number(octets);
  const candidates = Array.isArray(interfaces) ? interfaces : [];
  if (candidates.some((entry) => interfaceBroadcast(entry) === target)) {
    return { ok: false, code: 'directed_broadcast' };
  }
  if (octets[0] === 169 && octets[1] === 254) return { ok: false, code: 'link_local' };
  const kind = classifyAddress(address);
  if (kind === null) return { ok: false, code: 'target_not_allowed' };
  return { ok: true, kind };
}

module.exports = {
  parseIPv6,
  unwrapMapped,
  classifyAddress,
  canonicalAddress,
  classifyUdpTarget,
};
