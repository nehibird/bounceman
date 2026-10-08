'use strict';
// --require preload: blocks all outbound network except loopback (127.0.0.1/::1/localhost).
// Patches net.Socket#connect (covers http/https/tls/undici-fetch sockets), tls.connect,
// dns.lookup/dns.promises.lookup, and globalThis.fetch as a belt-and-suspenders guard.
//
// Usage: `node --require ./tests/block-net.js tests/<suite>.test.js` (a blocked attempt
// prints `BLOCKED-NET <host>:<port>` to stderr instead of silently hitting the network).

const net = require('net');
const tls = require('tls');
const dns = require('dns');

function isLoopbackHost(host) {
  if (host == null) return true; // no host (e.g. unix socket path) - let it through
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) return true;
  return false;
}

function blockedError(host, port) {
  process.stderr.write(`BLOCKED-NET ${host}:${port == null ? '' : port}\n`);
  const err = new Error(`connect ECONNREFUSED ${host}:${port == null ? '' : port} (blocked by block-net.js)`);
  err.code = 'ECONNREFUSED';
  err.errno = -61;
  err.syscall = 'connect';
  err.address = host;
  err.port = port;
  return err;
}

// ---- net.Socket.prototype.connect ----
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(...args) {
  let options = args[0];
  // marcus-pr7 fix: net.connect/createConnection (and so http/https agents) call
  // socket.connect(normalizedArgsArray); unwrap it or IP literals slip through.
  if (Array.isArray(options)) options = options[0];
  let host, port;

  if (typeof options === "object" && options !== null && !Array.isArray(options)) {
    // net.connect({ port, host }) or ({ path }) for IPC sockets
    if (options.path) {
      return origConnect.apply(this, args); // unix domain socket, not network
    }
    host = options.host || 'localhost';
    port = options.port;
  } else if (typeof options === 'number' || (typeof options === 'string' && /^\d+$/.test(options))) {
    port = Number(options);
    host = typeof args[1] === 'string' ? args[1] : 'localhost';
  } else if (typeof options === 'string') {
    // could be a unix socket path (net.connect(path, cb))
    return origConnect.apply(this, args);
  }

  if (!isLoopbackHost(host)) {
    const err = blockedError(host, port);
    // marcus-pr7: setImmediate + destroy(err) (emits error once) so http.ClientRequest
    // has attached its socket listeners first; nextTick+emit crashed with an unhandled error.
    setImmediate(() => this.destroy(err));
    return this;
  }

  return origConnect.apply(this, args);
};

// ---- tls.connect ----
const origTlsConnect = tls.connect;
tls.connect = function patchedTlsConnect(...args) {
  let options = args[0];
  let host, port;

  if (typeof options === 'object' && options !== null) {
    host = options.host || options.servername || 'localhost';
    port = options.port;
  } else if (typeof options === 'number') {
    port = options;
    host = typeof args[1] === 'string' ? args[1] : 'localhost';
  }

  if (!isLoopbackHost(host)) {
    const err = blockedError(host, port);
    const fakeSocket = new (require('events').EventEmitter)();
    for (const m of ['setTimeout','setKeepAlive','setNoDelay','write','end','destroy','pipe','unref','ref','removeAllListeners']) if (typeof fakeSocket[m] !== 'function') fakeSocket[m] = function () { return fakeSocket; };
    process.nextTick(() => fakeSocket.emit('error', err));
    return fakeSocket;
  }

  return origTlsConnect.apply(this, args);
};

// marcus-pr7: undo the tls.connect override. Its fake EventEmitter emitted the error on
// nextTick, before https.ClientRequest attached listeners (unhandled-error crash). The real
// TLSSocket connects through the patched net.Socket.prototype.connect above, which blocks it.
tls.connect = origTlsConnect;

// ---- dns.lookup ----
const origLookup = dns.lookup;
dns.lookup = function patchedLookup(hostname, ...rest) {
  if (!isLoopbackHost(hostname)) {
    process.stderr.write(`BLOCKED-NET ${hostname}:dns-lookup\n`);
    const cb = rest[rest.length - 1];
    const err = new Error(`getaddrinfo ENOTFOUND ${hostname} (blocked by block-net.js)`);
    err.code = 'ENOTFOUND';
    err.errno = -3008;
    err.syscall = 'getaddrinfo';
    err.hostname = hostname;
    if (typeof cb === 'function') {
      process.nextTick(() => cb(err));
      return;
    }
    throw err;
  }
  return origLookup.call(dns, hostname, ...rest);
};

if (dns.promises && dns.promises.lookup) {
  const origPromiseLookup = dns.promises.lookup;
  dns.promises.lookup = function patchedPromiseLookup(hostname, ...rest) {
    if (!isLoopbackHost(hostname)) {
      process.stderr.write(`BLOCKED-NET ${hostname}:dns-lookup\n`);
      const err = new Error(`getaddrinfo ENOTFOUND ${hostname} (blocked by block-net.js)`);
      err.code = 'ENOTFOUND';
      err.errno = -3008;
      err.syscall = 'getaddrinfo';
      err.hostname = hostname;
      return Promise.reject(err);
    }
    return origPromiseLookup.call(dns.promises, hostname, ...rest);
  };
}

// ---- globalThis.fetch ----
if (typeof globalThis.fetch === 'function') {
  const origFetch = globalThis.fetch;
  globalThis.fetch = function patchedFetch(input, init) {
    let urlStr;
    try {
      urlStr = typeof input === 'string' ? input : (input && input.url) ? input.url : String(input);
      const u = new URL(urlStr, 'http://localhost/');
      if (!isLoopbackHost(u.hostname)) {
        process.stderr.write(`BLOCKED-NET ${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}\n`);
        return Promise.reject(new TypeError(`fetch failed: blocked by block-net.js (${u.hostname})`));
      }
    } catch (e) {
      // If URL parsing fails, fall through to original fetch and let it error naturally.
    }
    return origFetch.call(this, input, init);
  };
}

process.stderr.write('block-net.js: loopback-only network guard active\n');

// ---- marcus-pr7 addition: force every nodemailer transport to a dead localhost port ----
// tests/routes-http.js deletes SMTP_HOST, so services/email.js would fall back to
// smtp-relay.brevo.com. The connect guard above already blocks that; this makes SMTP
// dead even if something bypasses the socket patch.
{
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const mod = origLoad.apply(this, arguments);
    if (request === 'nodemailer' && mod && !mod.__marcusPatched) {
      const origCreate = mod.createTransport;
      mod.createTransport = function (opts, defaults) {
        if (opts && typeof opts === 'object') {
          opts = Object.assign({}, opts, { host: '127.0.0.1', port: 9, secure: false, ignoreTLS: true });
          delete opts.service;
        }
        process.stderr.write('SMTP-FORCED-DEAD 127.0.0.1:9\n');
        return origCreate.call(this, opts, defaults);
      };
      mod.__marcusPatched = true;
    }
    return mod;
  };
}
