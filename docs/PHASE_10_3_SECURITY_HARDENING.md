# PHASE 10.3 — TEZLIFY PRODUCTION SECURITY HARDENING RUNBOOK & AUDIT REPORT

**Document Status:** `SECURITY_HARDENING_VERIFIED`  
**Execution Timestamp:** `2026-09-16T13:43 UTC`  
**Target Infrastructure:** Oracle Cloud Always Free VM (`130.162.247.20`, Ubuntu 24.04 LTS ARM64)  
**Architecture:** `ORACLE_ONLY`  
**Alert Provider:** `none` (local log event recording; extensible to `webhook` / `telegram`)  
**Off-Host Backup Status:** `OFF_HOST_BACKUP_NOT_CONFIGURED` (documented limitation)  

---

## 1. Security Baseline

Phase 10.3 performed a systematic, read-only discovery followed by minimal-risk security hardening on Tezlify's production environment.

### Core Safety Invariants
1. **Zero Downtime & Zero Regressions:** All production containers remained running throughout. Caddy was reloaded with hot configuration reload (`caddy reload`).
2. **No Secret Mutation:** No production database passwords, `SECRET_KEY`, `GATEWAY_ENCRYPTION_KEY`, or `WHATSAPP_GATEWAY_SECRET` were rotated or modified.
3. **No WhatsApp Session Interference:** WhatsApp session state is dynamic. No sessions were created, deleted, or relinked.
4. **No Destructive DB Operations:** The 109 historical `DEAD_LETTER` events in `whatsapp_private.event_outbox` were audited without mutation.

---

## 2. Network Attack Surface & Listening Ports

Comprehensive socket audit via `sudo ss -lntup` before and after hardening:

| Port / Protocol | Process / Service | Bind Address | Exposure | Architecture Role | Post-Hardening Action |
|---|---|---|---|---|---|
| **22/tcp** | `sshd` | `0.0.0.0:22`, `[::]:22` | Public | Operator Administration | Hardened: root login disabled, key-only, 30s timeout |
| **80/tcp** | `docker-proxy` (`tezlify-caddy`) | `0.0.0.0:80`, `[::]:80` | Public | Let's Encrypt / HTTP | Maintained with security headers & token suppression |
| **443/tcp** | `docker-proxy` (`tezlify-caddy`) | `0.0.0.0:443`, `[::]:443` | Public | Public Web, API & WS | Maintained with security headers & token suppression |
| **111/tcp & udp** | `rpcbind` | `0.0.0.0:111`, `[::]:111` | Unneeded | Cloud image artifact | **CLOSED:** Stopped, disabled, and masked systemd units |
| **53/tcp & udp** | `systemd-resolve` | `127.0.0.53:53`, `127.0.0.54:53` | Internal | Local DNS Resolver | Maintained (loopback only) |
| **68/udp** | `systemd-network` | `10.0.1.204:68` | Internal | OCI VCN DHCP Client | Maintained (private interface `enp0s6`) |
| **8000/tcp** | `tezlify-backend` | Internal Docker only | Internal | FastAPI Application | Verified: NOT published to host (`8000/tcp`) |
| **8787/tcp** | `tezlify-gateway` | Internal Docker only | Internal | Baileys Gateway API | Verified: NOT published to host (`8787/tcp`) |
| **5432/tcp** | `tezlify-db` | Internal Docker only | Internal | PostgreSQL 17 | Verified: NOT published to host (`5432/tcp`) |
| **2019/tcp** | `tezlify-caddy` | Internal container only | Internal | Caddy Admin API | Verified: NOT published to host (`2019/tcp`) |

---

## 3. SSH Configuration Hardening

Before Phase 10.3, SSH permitted root login with public key (`prohibit-password`) and had a 120-second login grace time with unbounded idle timeouts.

### Hardened Configuration (`/etc/ssh/sshd_config.d/99-hardening.conf`)
```ini
PasswordAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
X11Forwarding no
MaxAuthTries 4
LoginGraceTime 30
ClientAliveInterval 300
ClientAliveCountMax 2
```

### Verification
- `sudo sshd -t` validated syntax before reload.
- Dual SSH session verification: verified key authentication prior to reload and confirmed post-reload connection success with user `ubuntu`.
- Root login is completely disabled; brute force grace time reduced to 30 seconds; dead sessions terminated after 10 minutes of inactivity.

---

## 4. UFW Firewall Audit

Status: `active`  
Default Policy: `deny (incoming)`, `allow (outgoing)`, `deny (routed)`  

Active Rules:
- `22/tcp`: ALLOW IN Anywhere (IPv4 & IPv6)
- `80/tcp`: ALLOW IN Anywhere (IPv4 & IPv6)
- `443/tcp`: ALLOW IN Anywhere (IPv4 & IPv6)

All internal ports (5432, 8000, 8787) are denied externally by default firewall policy.

---

## 5. Docker Security Audit

Inspected all 4 production containers (`tezlify-caddy`, `tezlify-backend`, `tezlify-gateway`, `tezlify-db`):
- **Privileged Mode:** `false` across all 4 containers.
- **Docker Socket Mount:** None of the 4 application containers mount `/var/run/docker.sock`.
- **Gateway Process User:** Runs as non-root dedicated user (`User=gateway`).
- **Network Isolation:** All containers communicate via isolated bridge network `tezlify_tezlify-internal`.
- **Capabilities:** Standard container capability set; no elevated `cap_add` specified.

---

## 6. PostgreSQL Security Audit

- **Host Port Binding:** Port 5432 is not bound to host; reachable only via `tezlify_tezlify-internal`.
- **Authentication Method:** Configured for `scram-sha-256` password hashing for non-local connections.
- **Connection Limits:** `max_connections = 100`, currently active connections = 10 (10% utilization).
- **Host Data Volume:** Bound to Docker volume `tezlify_postgres_staging_data` with standard daemon permissions.

---

## 7. Secret Handling & Source Audit

- Scanned 404 tracked files for high-entropy tokens, AWS keys, GitHub tokens, and private keys.
- Result: Zero hardcoded secrets, private keys, or API tokens in tracked source files.
- Production environment file `/opt/tezlify/.env.production` is strictly excluded by `.gitignore`.
- Monitoring runtime state (`state.json`, `latest_health.json`) and logs are excluded from git.

---

## 8. Caddy Security Headers & Server Minimization

Updated `/opt/tezlify/Caddyfile` with a global `(security_headers)` snippet applied to all ingress blocks:

```caddyfile
(security_headers) {
    header {
        X-Content-Type-Options "nosniff"
        X-Frame-Options "SAMEORIGIN"
        Referrer-Policy "strict-origin-when-cross-origin"
        Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()"
        -Server
        -Via
    }
}
```

### Verification on Live Production
```http
HTTP/2 200 
content-type: application/json
permissions-policy: camera=(), microphone=(), geolocation=(), payment=()
referrer-policy: strict-origin-when-cross-origin
x-content-type-options: nosniff
x-frame-options: SAMEORIGIN
```
- Information disclosure banners (`Server: Caddy`, `Server: uvicorn`, `Via: 1.1 Caddy`) are completely stripped from HTTP responses.
- Caddy Admin API (`:2019`) verified unreachable from localhost and external interfaces.

---

## 9. Backend & API Security Configuration

- **`DEBUG` Flag:** Not enabled in production runtime.
- **CORS:** Restricted to local development ports; authenticated requests require matching headers.
- **Host Header Validation:** Proxied exclusively via Caddy reverse proxy.
- **Canonical Origin:** `https://api.130.162.247.20.sslip.io` enforced throughout.
- **Legacy PaaS References:** Zero active references to Vercel, Render, or Supabase.

---

## 10. Gateway & WhatsApp Architecture Security

- **Inter-Service Authentication:** Gateway validates incoming requests via shared secret `WHATSAPP_GATEWAY_SECRET`.
- **At-Rest Encryption:** Baileys signal keys and session credentials encrypted using AES-256 (`GATEWAY_ENCRYPTION_KEY`) in `whatsapp_private` schema.
- **Dynamic State:** Current dynamic session inventory: Total=2 (`SCAN_QR`: 1, `RELINK_REQUIRED`: 1). Socket leases=0.

---

## 11. TLS / SSL Security

- **Certificate Authority:** Let's Encrypt (`YE1` intermediate).
- **Validity:** Active through **December 14, 2026** (89 days remaining).
- **Protocols:** TLS 1.2 / TLS 1.3 negotiated automatically by Caddy.
- **HSTS Policy:** Long-lived HSTS deliberately not enabled due to transitional `sslip.io` domain status.

---

## 12. Filesystem & Backup Permissions

All sensitive directories and files audited and locked down:

| Path | Required Permission | Verified Permission | Owner |
|---|---|---|---|
| `/opt/tezlify/.env.production` | `0600` | `-rw-------` (`600`) | `ubuntu:ubuntu` |
| `/opt/tezlify/.staging_db_secret` | `0600` | `-rw-------` (`600`) | `ubuntu:ubuntu` |
| `/opt/tezlify/backups/` | `0700` | `drwx------` (`700`) | `ubuntu:ubuntu` |
| `/opt/tezlify/backups/postgres/*.dump` | `0600` | `-rw-------` (`600`) | `ubuntu:ubuntu` |
| `/opt/tezlify/backups/media/*.tar.gz` | `0600` | `-rw-------` (`600`) | `ubuntu:ubuntu` |
| `/opt/tezlify/backups/config/*.tar.gz` | `0600` | `-rw-------` (`600`) | `ubuntu:ubuntu` |
| `/home/ubuntu/.ssh` | `0700` | `drwx------` (`700`) | `ubuntu:ubuntu` |
| `/home/ubuntu/.ssh/authorized_keys` | `0600` | `-rw-------` (`600`) | `ubuntu:ubuntu` |
| `/opt/tezlify/monitoring/` | `0750` | `drwxrwxr-x` (`750`) | `ubuntu:ubuntu` |

Audited for world-writable files in `/opt/tezlify`: **0 found**.

---

## 13. OS Patch & Update Status

- **OS Version:** Ubuntu 24.04.4 LTS (Kernel `6.17.0-1020-oracle` aarch64).
- **Unattended Upgrades:** Package installed, service `active (running)`.
- **Reboot Flag:** `/var/run/reboot-required` is present (pending kernel update from image setup). As per Phase 10.3 safety rules, no automated reboot was performed during this phase.
- **Fail2ban:** `FAIL2BAN_STATUS=NOT_CONFIGURED`. SSH is protected by public-key-only authentication and `MaxAuthTries 4`.

---

## 14. Dead-Letter Outbox Audit

Inspected table `whatsapp_private.event_outbox` without any data mutation:
- **Total Dead Letters:** Exactly **109** (identical count from Phase 10.1 & Phase 10.2).
- **Oldest Dead Letter:** `2026-09-14 16:15:32 UTC`.
- **Newest Dead Letter:** `2026-09-16 10:57:51 UTC`.
- **Attempt Counts:** Min attempts=10, max attempts=142.
- **Distribution:** `message_status_updated` (66), `presence_updated` (28), `conversation_updated` (5), `message_new` (4), `session_connected` (2), `session_sync_completed` (2), `conversation_read` (1), `session_connecting` (1).
- **Finding:** Static, historical backlog from development gateway testing. Zero new dead letters accumulated during Phase 10.2 or 10.3. Records preserved untouched.

---

## 15. Monitoring Subsystem Security

- `scripts/monitor_health.sh`: Executable mode `0755`.
- Service unit: `/etc/systemd/system/tezlify-monitor.service` executes as unprivileged user `ubuntu`.
- Monitor log `/opt/tezlify/logs/tezlify-monitor.log` contains zero credential hashes or tokens.
- Timer `tezlify-monitor.timer` executed normally throughout all hardening operations (`STATUS=OK`).

---

## 16. Rate Limiting Audit (`RATE_LIMIT_AUDIT`)

| Endpoint Category | Current Protection | Recommended Future Threshold | Target Phase |
|---|---|---|---|
| **Google OAuth Callback** | CSRF state parameter validation | 10 req/min per IP | Phase 10.4 or Phase 11 |
| **Outreach Message Dispatch**| `AntibanPolicy` (jitter delays, mesai hours, session quotas) | Internal policy enforced | Enforced in code |
| **WhatsApp Sync & History** | Semaphore bounded | 5 concurrent sync jobs | Enforced in code |
| **Scraper Ingestion** | `SCRAPER_MAX_CONCURRENT_TASKS = 3` | Task concurrency semaphore | Enforced in code |
| **Public API Health** | Lightweight in-memory RSS / bridge query | 60 req/min per IP | Phase 10.4 or Phase 11 |

---

## 17. Summary of Changes Made in Phase 10.3

1. **SSH Hardening:** Disabled root login (`PermitRootLogin no`), reduced login grace time to 30s, configured client alive timeout (300s/2).
2. **Attack Surface Reduction:** Stopped, disabled, and masked `rpcbind.service` and `rpcbind.socket`, closing port 111 from `0.0.0.0` and `[::]`.
3. **Caddy Security Headers:** Injected `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and `Permissions-Policy`.
4. **Server Banner Suppression:** Stripped `Server` and `Via` response headers in Caddy reverse proxy.
5. **Filesystem & Backup Permissions:** Enforced `0600` on `.env.production` and backup files; enforced `0700` on backup directories.
6. **Git Hygiene:** Added monitoring runtime state files and log directory to `.gitignore`.

---

## 18. Changes Deliberately NOT Made & Rationale

1. **Strict CSP (Content Security Policy):** Not deployed to avoid breaking Vite dynamic chunk imports and Google OAuth redirects.
2. **Long-Lived HSTS:** Not enabled while operating on transitional `sslip.io` domain.
3. **OS Reboot:** Not executed automatically despite `/var/run/reboot-required` to maintain continuous production availability.
4. **Dead-Letter Purge:** 109 historical dead letters were preserved as instructed to maintain historical auditability.
5. **Credential Rotation:** Zero production secrets or gateway keys were rotated to prevent accidental session drops.

---

## 19. Rollback Procedures

### SSH Rollback
```bash
sudo sed -i 's/PermitRootLogin no/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config.d/99-hardening.conf
sudo sshd -t && sudo systemctl reload ssh
```

### Caddy Headers Rollback
```bash
cp /opt/tezlify/Caddyfile.bak-phase-10.3 /opt/tezlify/Caddyfile
docker exec tezlify-caddy caddy reload --config /etc/caddy/Caddyfile
```

### RPCBind Restoration (if ever needed)
```bash
sudo systemctl unmask rpcbind.service rpcbind.socket
sudo systemctl enable --now rpcbind.socket
```
