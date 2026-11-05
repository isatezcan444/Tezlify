/**
 * WhatsApp Gateway - Runtime Network Egress Firewall.
 *
 * Enforces strict OS/runtime level network egress isolation:
 * - Intercepts `net.Socket.prototype.connect` to guarantee that ONLY loopback
 *   destinations (127.0.0.1, localhost, ::1, Unix domain sockets) can be contacted.
 * - Any outbound WAN connection (e.g. Meta IPs, WhatsApp servers, external hosts)
 *   is terminated immediately fail-closed with error code `ENETUNREACH`.
 * - Intercepts `dns.lookup` to prevent DNS queries for external domains.
 * - Maintains detailed audit statistics and blocked target history.
 */

import net from 'net';
import dns from 'dns';

let isInstalled = false;
let origNetConnect = null;
let origDnsLookup = null;

const auditStats = {
  active: false,
  installed_at: null,
  loopback_allowed_count: 0,
  wan_blocked_count: 0,
  dns_blocked_count: 0,
  blocked_targets: [],
};

const MAX_BLOCKED_TARGETS_HISTORY = 100;

/**
 * Extracts host, port, and path from varied net.connect argument signatures.
 * Supports:
 * - connect(options, [cb])
 * - connect(port, [host], [cb])
 * - connect(path, [cb])
 * - Internal Node normalizeArgs arrays
 */
function extractTarget(args) {
  let first = args[0];
  if (Array.isArray(first)) {
    first = first[0];
  }

  if (typeof first === 'object' && first !== null) {
    return {
      host: first.host || first.hostname || '127.0.0.1',
      port: Number(first.port) || 0,
      path: first.path || null,
    };
  }

  if (typeof first === 'number') {
    return {
      host: (typeof args[1] === 'string' && args[1]) ? args[1] : '127.0.0.1',
      port: first,
      path: null,
    };
  }

  if (typeof first === 'string') {
    if (first.startsWith('/') || first.startsWith('\\\\') || first.includes('.sock')) {
      return { host: null, port: 0, path: first };
    }
    return { host: first, port: Number(args[1]) || 0, path: null };
  }

  return { host: '127.0.0.1', port: 0, path: null };
}

/**
 * Determines whether a given host or address qualifies as local loopback.
 */
function isLoopbackAddress(host) {
  if (!host) return false;
  const h = host.toLowerCase().trim();
  return (
    h === '127.0.0.1' ||
    h === 'localhost' ||
    h === '::1' ||
    h === '0.0.0.0' ||
    h === 'ip6-localhost' ||
    h === 'ip6-loopback' ||
    h.startsWith('127.')
  );
}

/**
 * Installs the runtime egress firewall monkeypatch.
 */
export function installEgressFirewall({ allowLoopbackOnly = true } = {}) {
  if (isInstalled) {
    return auditStats;
  }

  origNetConnect = net.Socket.prototype.connect;
  origDnsLookup = dns.lookup;

  net.Socket.prototype.connect = function (...args) {
    const target = extractTarget(args);
    const isLoopback = target.path != null || isLoopbackAddress(target.host);

    if (!isLoopback && allowLoopbackOnly) {
      auditStats.wan_blocked_count++;
      const blockedRecord = {
        host: target.host,
        port: target.port,
        path: target.path,
        timestamp: new Date().toISOString(),
        reason: 'EGRESS_FIREWALL_NON_LOOPBACK',
      };
      if (auditStats.blocked_targets.length >= MAX_BLOCKED_TARGETS_HISTORY) {
        auditStats.blocked_targets.shift();
      }
      auditStats.blocked_targets.push(blockedRecord);

      const err = new Error(
        `EGRESS_FIREWALL_BLOCKED: Outbound WAN connection to ${target.host}:${target.port} prohibited in test mode`
      );
      err.code = 'ENETUNREACH';
      err.address = target.host;
      err.port = target.port;

      process.nextTick(() => {
        this.emit('error', err);
        this.destroy(err);
      });
      return this;
    }

    auditStats.loopback_allowed_count++;
    return origNetConnect.apply(this, args);
  };

  dns.lookup = function (hostname, options, callback) {
    let cb = callback;
    let opt = options;
    if (typeof opt === 'function') {
      cb = opt;
      opt = {};
    }

    if (hostname && !isLoopbackAddress(hostname)) {
      auditStats.dns_blocked_count++;
      const blockedRecord = {
        host: hostname,
        type: 'DNS',
        timestamp: new Date().toISOString(),
        reason: 'EGRESS_FIREWALL_DNS_BLOCKED',
      };
      if (auditStats.blocked_targets.length >= MAX_BLOCKED_TARGETS_HISTORY) {
        auditStats.blocked_targets.shift();
      }
      auditStats.blocked_targets.push(blockedRecord);

      const err = new Error(`EGRESS_FIREWALL_BLOCKED: DNS resolution prohibited for ${hostname}`);
      err.code = 'ENOTFOUND';
      err.hostname = hostname;

      if (typeof cb === 'function') {
        process.nextTick(() => cb(err, null, 4));
        return;
      }
    }

    return origDnsLookup.call(dns, hostname, opt, cb);
  };

  isInstalled = true;
  auditStats.active = true;
  auditStats.installed_at = new Date().toISOString();

  return auditStats;
}

/**
 * Returns current audit statistics.
 */
export function getEgressAuditStats() {
  return {
    ...auditStats,
    blocked_targets: [...auditStats.blocked_targets],
  };
}

/**
 * Resets the audit counters (useful between test cases).
 */
export function resetEgressAuditStats() {
  auditStats.loopback_allowed_count = 0;
  auditStats.wan_blocked_count = 0;
  auditStats.dns_blocked_count = 0;
  auditStats.blocked_targets = [];
}

/**
 * Probes an egress connection to verify fail-closed blocking.
 */
export function probeEgress(host = '1.1.1.1', port = 443) {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    let resolved = false;

    const cleanup = () => {
      s.removeAllListeners();
      try { s.destroy(); } catch (_) {}
    };

    s.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve({
          blocked: true,
          code: err.code || 'UNKNOWN_ERROR',
          message: err.message,
          target: { host, port },
        });
      }
    });

    s.on('connect', () => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve({
          blocked: false,
          code: 'CONNECTED_LEAK',
          message: `CRITICAL: Connection to ${host}:${port} succeeded! Firewall failed!`,
          target: { host, port },
        });
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve({
          blocked: true,
          code: 'TIMEOUT',
          message: 'Connection timed out without connect event',
          target: { host, port },
        });
      }
    }, 2000);
  });
}
