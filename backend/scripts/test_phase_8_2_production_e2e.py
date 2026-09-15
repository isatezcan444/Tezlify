import asyncio
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1280, "height": 800})
        page = await context.new_page()

        print("[TEST] Navigating to https://tezlify-woad.vercel.app ...")
        await page.goto("https://tezlify-woad.vercel.app", wait_until="networkidle")
        
        # Take initial screenshot
        await page.screenshot(path="/Users/isatezcan/.gemini/antigravity-ide/brain/68bc2c3a-6fe0-4a70-a55c-a06af81221f7/phase_8_2_production_login_page.png")
        print("[TEST] Saved initial login page screenshot.")

        # Find Google login button
        btn = page.locator("button:has-text('Google')")
        btn_count = await btn.count()
        print(f"[TEST] Found {btn_count} Google button(s).")
        assert btn_count > 0, "No Google button found on login page"

        # Listen for navigation
        print("[TEST] Clicking Google login button...")
        async with page.expect_navigation(timeout=15000) as nav_info:
            await btn.first.click()

        nav_url = page.url
        print(f"[TEST] Redirected to URL: {nav_url}")

        parsed = urlparse(nav_url)
        print(f"[TEST] Host: {parsed.netloc}")
        print(f"[TEST] Path: {parsed.path}")

        query = parse_qs(parsed.query)
        client_id = query.get("client_id", [None])[0]
        redirect_uri = query.get("redirect_uri", [None])[0]
        state = query.get("state", [None])[0]

        print(f"[TEST] client_id match: {client_id == '662374503405-m74guv10a7p5lvrja6dt49bl2afmp1k0.apps.googleusercontent.com'}")
        print(f"[TEST] redirect_uri match: {redirect_uri == 'https://api.130.162.247.20.sslip.io/api/v1/auth/google/callback'}")
        print(f"[TEST] state present: {bool(state and len(state) > 10)}")

        # Screenshot on Google consent / login screen
        await page.screenshot(path="/Users/isatezcan/.gemini/antigravity-ide/brain/68bc2c3a-6fe0-4a70-a55c-a06af81221f7/phase_8_2_google_consent_screen.png")
        print("[TEST] Saved Google consent screen screenshot.")

        assert parsed.netloc == "accounts.google.com", f"Expected accounts.google.com, got {parsed.netloc}"
        assert client_id == "662374503405-m74guv10a7p5lvrja6dt49bl2afmp1k0.apps.googleusercontent.com", "Client ID mismatch"
        assert redirect_uri == "https://api.130.162.247.20.sslip.io/api/v1/auth/google/callback", "Redirect URI mismatch"
        assert state is not None, "Missing state parameter"

        print("[TEST] SUCCESS: Oracle Native Auth Google OAuth flow reached Google consent screen with exact production credentials!")
        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
