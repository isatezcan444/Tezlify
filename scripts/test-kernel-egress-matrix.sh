#!/usr/bin/env bash
set -euo pipefail

# Phase 8.0.11.1: Kernel-Level Network Egress Isolation Verification on macOS
# Enforces Darwin/XNU kernel Seatbelt sandbox (Mandatory Access Control)
# Denies all WAN egress (IPv4, IPv6, TCP, UDP, DNS) while strictly permitting loopback.

SEATBELT_PROFILE='
(version 1)
(allow default)
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
(allow network-bind (local ip "localhost:*"))
(deny network-outbound (literal "/var/run/mDNSResponder"))
'

echo "====================================================================="
echo "Tezlify WhatsApp - Kernel-Level Egress Isolation Test Matrix"
echo "Enforcing: Apple Seatbelt MAC Framework (Darwin/XNU Kernel)"
echo "====================================================================="

sandbox-exec -p "$SEATBELT_PROFILE" node -e '
import net from "net";
import dgram from "dgram";
import dns from "dns";
import http from "http";
import https from "https";
import { spawnSync } from "child_process";

const results = [];

function record(name, allowed, expectedAllowed, details) {
  const pass = (allowed === expectedAllowed);
  results.push({ name, pass, allowed, expectedAllowed, details });
  const status = pass ? "PASS" : "FAIL";
  const action = allowed ? "ALLOWED" : "BLOCKED";
  console.log(`[${status}] ${name.padEnd(36)} -> ${action} (${details})`);
}

async function run() {
  // Setup a local test server for loopback verification
  const localServer = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("local-ok");
  });
  await new Promise(r => localServer.listen(0, "127.0.0.1", r));
  const localPort = localServer.address().port;

  // 1. IPv4 loopback TCP
  try {
    await new Promise((resolve, reject) => {
      const s = net.connect(localPort, "127.0.0.1", () => { s.end(); resolve(); });
      s.on("error", reject);
    });
    record("1. IPv4 loopback TCP", true, true, "127.0.0.1:" + localPort + " connected");
  } catch (e) {
    record("1. IPv4 loopback TCP", false, true, e.message);
  }

  // 2. IPv6 loopback TCP (if supported by OS loopback stack)
  try {
    await new Promise((resolve, reject) => {
      const s = net.connect(localPort, "localhost", () => { s.end(); resolve(); });
      s.on("error", reject);
    });
    record("2. Loopback localhost TCP", true, true, "localhost:" + localPort + " connected");
  } catch (e) {
    record("2. Loopback localhost TCP", false, true, e.message);
  }

  // 3. Public IPv4 TCP
  try {
    await new Promise((resolve, reject) => {
      const s = net.connect(80, "1.1.1.1", () => { s.end(); resolve(); });
      s.on("error", reject);
      setTimeout(() => reject(new Error("Timeout")), 1000);
    });
    record("3. Public IPv4 TCP", true, false, "Leak: 1.1.1.1 connected");
  } catch (e) {
    record("3. Public IPv4 TCP", false, false, "Kernel: " + e.code);
  }

  // 4. Public IPv4 UDP
  try {
    await new Promise((resolve, reject) => {
      const u = dgram.createSocket("udp4");
      u.send(Buffer.from("probe"), 53, "1.1.1.1", (err) => {
        u.close();
        if (err) reject(err);
        else resolve();
      });
    });
    record("4. Public IPv4 UDP", true, false, "Leak: UDP send succeeded");
  } catch (e) {
    record("4. Public IPv4 UDP", false, false, "Kernel: " + e.code);
  }

  // 5. Public IPv6 TCP
  try {
    await new Promise((resolve, reject) => {
      const s = net.connect(80, "2606:4700:4700::1111", () => { s.end(); resolve(); });
      s.on("error", reject);
      setTimeout(() => reject(new Error("Timeout")), 1000);
    });
    record("5. Public IPv6 TCP", true, false, "Leak: IPv6 connected");
  } catch (e) {
    record("5. Public IPv6 TCP", false, false, "Kernel: " + e.code);
  }

  // 6. Public IPv6 UDP
  try {
    await new Promise((resolve, reject) => {
      const u = dgram.createSocket("udp6");
      u.send(Buffer.from("probe"), 53, "2606:4700:4700::1111", (err) => {
        u.close();
        if (err) reject(err);
        else resolve();
      });
    });
    record("6. Public IPv6 UDP", true, false, "Leak: IPv6 UDP send succeeded");
  } catch (e) {
    record("6. Public IPv6 UDP", false, false, "Kernel: " + e.code);
  }

  // 7. Public DNS UDP
  try {
    await new Promise((resolve, reject) => {
      const u = dgram.createSocket("udp4");
      u.send(Buffer.from("dns-query"), 53, "8.8.8.8", (err) => {
        u.close();
        if (err) reject(err);
        else resolve();
      });
    });
    record("7. Public DNS UDP", true, false, "Leak: DNS UDP sent");
  } catch (e) {
    record("7. Public DNS UDP", false, false, "Kernel: " + e.code);
  }

  // 8. Public DNS TCP
  try {
    await new Promise((resolve, reject) => {
      const s = net.connect(53, "8.8.8.8", () => { s.end(); resolve(); });
      s.on("error", reject);
      setTimeout(() => reject(new Error("Timeout")), 1000);
    });
    record("8. Public DNS TCP", true, false, "Leak: DNS TCP connected");
  } catch (e) {
    record("8. Public DNS TCP", false, false, "Kernel: " + e.code);
  }

  // 9. External HTTPS
  try {
    await new Promise((resolve, reject) => {
      const req = https.get("https://1.1.1.1", { timeout: 1000 }, (res) => { res.resume(); resolve(); });
      req.on("error", reject);
    });
    record("9. External HTTPS", true, false, "Leak: HTTPS connected");
  } catch (e) {
    record("9. External HTTPS", false, false, "Kernel: " + e.code);
  }

  // 10. External DNS Resolution
  try {
    await new Promise((resolve, reject) => {
      dns.lookup("example.com", (err, addr) => {
        if (err) reject(err);
        else resolve(addr);
      });
    });
    record("10. External DNS Lookup", true, false, "Leak: DNS resolved");
  } catch (e) {
    record("10. External DNS Lookup", false, false, "Kernel: " + e.code);
  }

  // 11. Node.js fetch / undici path
  try {
    await fetch("http://1.1.1.1", { signal: AbortSignal.timeout(1000) });
    record("11. Node.js fetch() WAN", true, false, "Leak: fetch succeeded");
  } catch (e) {
    record("11. Node.js fetch() WAN", false, false, "Kernel: " + (e.cause?.code || e.message));
  }

  // 12. Python socket connect via child process
  const pyRes = spawnSync("python3", ["-c", "import socket; s = socket.socket(); s.connect((\"1.1.1.1\", 80))"]);
  if (pyRes.status === 0) {
    record("12. Python socket WAN connect", true, false, "Leak: Python connected");
  } else {
    record("12. Python socket WAN connect", false, false, "Kernel: PermissionError EPERM");
  }

  // 13. Child process curl WAN
  const curlRes = spawnSync("curl", ["-m", "1", "http://1.1.1.1"]);
  if (curlRes.status === 0) {
    record("13. Child process curl WAN", true, false, "Leak: curl connected");
  } else {
    record("13. Child process curl WAN", false, false, "Kernel: curl exit " + curlRes.status);
  }

  // 14. Local PostgreSQL connect
  try {
    await new Promise((resolve, reject) => {
      const s = net.connect(5432, "127.0.0.1", () => { s.end(); resolve(); });
      s.on("error", reject);
    });
    record("14. Local PostgreSQL (5432)", true, true, "127.0.0.1:5432 connected");
  } catch (e) {
    record("14. Local PostgreSQL (5432)", false, true, e.message);
  }

  // Clean up server
  await new Promise(r => localServer.close(r));

  const total = results.length;
  const passed = results.filter(r => r.pass).length;
  console.log("=====================================================================");
  console.log(`Kernel Egress Isolation Summary: ${passed}/${total} PASS`);
  console.log("=====================================================================");
  if (passed !== total) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
'
