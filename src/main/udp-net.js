// Small helpers shared by the UDP endpoint, the UDP device and the UDP relay.
const dns = require('node:dns');
const net = require('node:net');
const os = require('node:os');

// IPv4 interfaces as { address, netmask }, for the broadcast check of the address policy.
function defaultInterfaces() {
  const list = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' || entry.family === 4) list.push({ address: entry.address, netmask: entry.netmask });
    }
  }
  return list;
}

// A literal address is returned as it is (the address policy then judges it, so an IPv6 literal is
// refused as such); a name is looked up as IPv4, because "localhost" alone resolves to ::1 first.
async function defaultResolve(host) {
  if (net.isIP(host)) return [host];
  const found = await dns.promises.lookup(host, { family: 4, all: true });
  return found.map((entry) => entry.address);
}

// Closes a socket and calls `done` once, after its 'close' event (or at once if it is not running
// any more), so the port is really free when the caller goes on.
function releaseThen(socket, done) {
  let called = false;
  const finishOnce = () => { if (!called) { called = true; done(); } };
  socket.once('close', finishOnce);
  try { socket.close(); } catch { finishOnce(); }
}

// Notices that a remote source can provoke at will are passed on at most once per interval per kind.
// The table has one entry per kind (a fixed set), so it cannot grow with the number of sources.
function createNoticeThrottle(now, intervalMs) {
  const last = new Map();
  return (key, send) => {
    const t = now();
    const before = last.get(key);
    if (before !== undefined && t - before < intervalMs) return;
    last.set(key, t);
    send();
  };
}

module.exports = {
  defaultInterfaces, defaultResolve, releaseThen, createNoticeThrottle,
};
