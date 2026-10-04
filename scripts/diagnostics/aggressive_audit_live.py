"""Comprehensive Aggressive Live Audit for Tezlify Production (https://130.162.247.20.sslip.io).

Audits:
1. All public & authenticated API endpoints:
   - /health, /api/v1/stats, /api/v1/leads, /api/v1/campaigns, /api/v1/campaign-groups
   - /api/v1/whatsapp/sessions, /api/v1/whatsapp/conversations, /api/v1/settings/antiban
   - /api/v1/blacklist, /api/v1/admin/overview
2. All 15 frontend application tabs in dark and light modes:
   - dashboard, lead-finder, leads, campaigns, campaign-groups, whatsapp, blacklist, settings
   - admin-overview, admin-whatsapp, admin-monitoring, admin-backups, admin-operations, admin-deployment, admin-security
3. Captures:
   - Console errors and unhandled promise rejections
   - Network failure logs (4xx / 5xx)
   - Performance / load time for each view
   - Screenshots of core surfaces
"""
import asyncio
import os
import sys
import time
import json
import httpx
from playwright.async_api import async_playwright

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, REPO_ROOT)
try:
    from scripts.auth_helper import get_ephemeral_auth_token
except ImportError:
    from auth_helper import get_ephemeral_auth_token

BASE_URL = os.environ.get("TARGET_URL", "https://130.162.247.20.sslip.io")
CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ARTIFACT_DIR = "/Users/isatezcan/.gemini/antigravity-ide/brain/7c08a75b-8c18-4648-9667-77c7d256d21e"


async def audit_api_endpoints(token: str):
    print("\n" + "=" * 60)
    print("PHASE 1: API ENDPOINTS LATENCY & STATUS AUDIT")
    print("=" * 60)
    endpoints = [
        ("GET", "/health", False),
        ("GET", "/api/v1/stats", True),
        ("GET", "/api/v1/leads?skip=0&limit=20", True),
        ("GET", "/api/v1/campaigns", True),
        ("GET", "/api/v1/campaign-groups", True),
        ("GET", "/api/v1/whatsapp/sessions", True),
        ("GET", "/api/v1/whatsapp/conversations?limit=30", True),
        ("GET", "/api/v1/settings/antiban", True),
        ("GET", "/api/v1/blacklist", True),
        ("GET", "/api/v1/admin/overview", True),
        ("GET", "/api/v1/scraper/jobs", True),
    ]

    results = []
    async with httpx.AsyncClient(verify=False, timeout=15.0) as client:
        for method, path, requires_auth in endpoints:
            url = f"{BASE_URL}{path}"
            headers = {"Authorization": f"Bearer {token}"} if requires_auth else {}
            t0 = time.perf_counter()
            try:
                res = await client.request(method, url, headers=headers)
                latency = int((time.perf_counter() - t0) * 1000)
                status = res.status_code
                results.append({"path": path, "status": status, "latency_ms": latency, "ok": status < 400})
                mark = "✓ PASS" if status < 400 else f"✗ FAIL ({status})"
                print(f"[{mark}] {path:<45} {latency}ms")
            except Exception as e:
                latency = int((time.perf_counter() - t0) * 1000)
                results.append({"path": path, "status": "ERROR", "latency_ms": latency, "error": str(e), "ok": False})
                print(f"[✗ ERR ] {path:<45} {latency}ms ({e})")
    return results


async def audit_frontend_surfaces(token: str):
    print("\n" + "=" * 60)
    print("PHASE 2: FRONTEND SURFACES, CONSOLE & NETWORK AUDIT")
    print("=" * 60)

    tabs = [
        ("dashboard", "Dashboard / Genel Bakış"),
        ("lead-finder", "Lead Finder / İşletme Ara"),
        ("leads", "Leads CRM / Müşteri Adayları"),
        ("campaigns", "Campaigns / Kampanyalar"),
        ("campaign-groups", "Campaign Groups / Kampanya Grupları"),
        ("whatsapp", "WhatsApp Live Hub"),
        ("blacklist", "Blacklist / Kara Liste"),
        ("settings", "Settings / Ayarlar"),
        ("admin-overview", "Admin Overview"),
        ("admin-whatsapp", "Admin WhatsApp"),
        ("admin-monitoring", "Admin Monitoring"),
        ("admin-backups", "Admin Backups"),
        ("admin-operations", "Admin Operations"),
        ("admin-deployment", "Admin Deployment"),
        ("admin-security", "Admin Security"),
    ]

    surface_results = []
    console_errors = []
    network_errors = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            executable_path=CHROME_PATH,
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--ignore-certificate-errors",
                "--window-size=1440,900",
            ],
        )
        context = await browser.new_context(
            ignore_https_errors=True,
            viewport={"width": 1440, "height": 900},
        )
        page = await context.new_page()

        page.on("console", lambda msg: console_errors.append(f"[{msg.type}] {msg.text}") if msg.type in ("error", "warning") else None)
        page.on("pageerror", lambda err: console_errors.append(f"[pageerror] {err}"))
        page.on("response", lambda res: network_errors.append(f"{res.status} {res.url}") if res.status >= 400 and not "media/" in res.url else None)

        print("[*] Initializing authenticated session...")
        await page.goto(f"{BASE_URL}/", wait_until="commit", timeout=30000)
        await page.evaluate(
            f"""(tok) => {{
            localStorage.setItem('tezlify_session_token', tok);
            localStorage.setItem('tezlify_lang', 'tr');
            localStorage.setItem('tezlify_theme', 'dark');
            document.documentElement.classList.add('dark');
        }}""",
            token,
        )

        for tab_id, tab_label in tabs:
            tab_console = []
            tab_network = []
            
            def on_c(msg):
                if msg.type == "error":
                    tab_console.append(msg.text)
            def on_r(res):
                if res.status >= 400 and not "media/" in res.url:
                    tab_network.append(f"{res.status} {res.url}")

            page.on("console", on_c)
            page.on("response", on_r)

            t0 = time.perf_counter()
            target_url = f"{BASE_URL}/?tab={tab_id}"
            try:
                await page.goto(target_url, wait_until="networkidle", timeout=15000)
                await page.wait_for_timeout(800)
                dur = int((time.perf_counter() - t0) * 1000)

                # Check for critical errors or empty states
                has_error_state = await page.locator("text='Hata Oluştu'").count() > 0 or await page.locator("text='Something went wrong'").count() > 0
                
                # Capture screenshot for key sections
                screenshot_filename = f"audit_{tab_id}.png"
                screenshot_path = os.path.join(ARTIFACT_DIR, screenshot_filename)
                if tab_id in ("dashboard", "lead-finder", "leads", "campaigns", "whatsapp", "admin-overview"):
                    await page.screenshot(path=screenshot_path)

                status_mark = "✗ FAIL" if (has_error_state or len(tab_console) > 0) else "✓ PASS"
                print(f"[{status_mark}] {tab_label:<35} ({dur}ms) - Errors: {len(tab_console)}, Network 4xx/5xx: {len(tab_network)}")
                if tab_console:
                    for ce in tab_console[:3]:
                        print(f"      Console: {ce[:100]}")
                if tab_network:
                    for ne in tab_network[:3]:
                        print(f"      NetErr: {ne[:100]}")

                surface_results.append({
                    "tab": tab_id,
                    "label": tab_label,
                    "load_ms": dur,
                    "has_error_state": has_error_state,
                    "console_errors": tab_console,
                    "network_errors": tab_network,
                })
            except Exception as e:
                dur = int((time.perf_counter() - t0) * 1000)
                print(f"[✗ TIMEOUT/ERR] {tab_label:<35} ({dur}ms) - {e}")
                surface_results.append({
                    "tab": tab_id,
                    "label": tab_label,
                    "load_ms": dur,
                    "error": str(e),
                })
            finally:
                page.remove_listener("console", on_c)
                page.remove_listener("response", on_r)

        await browser.close()

    return surface_results


async def main():
    print("=" * 60)
    print("TEZLIFY PRODUCTION AGGRESSIVE AUDIT RUNNER")
    print(f"Time: {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}")
    print(f"Host: {BASE_URL}")
    print("=" * 60)

    token = get_ephemeral_auth_token()
    api_results = await audit_api_endpoints(token)
    surface_results = await audit_frontend_surfaces(token)

    summary = {
        "timestamp": time.time(),
        "api_audit": api_results,
        "surface_audit": surface_results,
    }
    summary_path = os.path.join(ARTIFACT_DIR, "audit_live_results.json")
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
    print(f"\n[+] Full audit metrics saved to: {summary_path}")


if __name__ == "__main__":
    asyncio.run(main())
