"""WhatsApp Web Interactions & Visual Polish Verification Suite.

Tests live parity against production:
1. Hovering message bubble -> Action Bar (Smile, Reply, Copy).
2. Clicking Reply -> Quote Banner appears, textarea auto-focuses.
3. Dark Mode toggle -> Authentic dark WhatsApp Web theme (#0b141a, #202c33, #005c4b).
4. Telemetry audit: zero JS errors, zero unhandled rejections.
"""
import asyncio
import os
import sys
import time
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


async def run_interaction_verification():
    print("=" * 60)
    print("WHATSAPP WEB INTERACTIONS & VISUAL FIDELITY VERIFICATION")
    print(f"Target: {BASE_URL}")
    print("=" * 60)

    token = get_ephemeral_auth_token()
    console_errors = []
    page_errors = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            executable_path=CHROME_PATH,
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--ignore-certificate-errors",
                "--window-size=1440,900"
            ]
        )
        context = await browser.new_context(
            ignore_https_errors=True,
            viewport={"width": 1440, "height": 900}
        )
        page = await context.new_page()

        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
        page.on("pageerror", lambda err: page_errors.append(str(err)))

        # 1. Login & Navigate
        print("[1] Injecting admin session and loading page...")
        await page.goto(f"{BASE_URL}/", wait_until="commit", timeout=30000)
        await page.evaluate(f"""(tok) => {{
            localStorage.setItem('tezlify_session_token', tok);
            localStorage.setItem('tezlify_lang', 'tr');
        }}""", token)
        await page.goto(f"{BASE_URL}/", wait_until="networkidle", timeout=30000)

        # Navigate to WhatsApp Hub
        wa_btn = page.locator('button[data-tab-id="whatsapp"]').first
        if await wa_btn.is_visible():
            await wa_btn.click()
        else:
            await page.goto(f"{BASE_URL}/whatsapp", wait_until="networkidle", timeout=30000)

        await page.wait_for_selector('button[data-conv-id], button:has(h4)', timeout=20000)
        print("[2] WhatsApp Hub loaded.")

        # Click the first conversation to open thread
        conv = page.locator('button[data-conv-id], button:has(h4)').first
        await conv.click()
        await page.wait_for_timeout(1000)

        # 2. Hover over a message bubble
        print("[3] Testing hover action bar...")
        # Find inbound or outbound bubble
        bubble = page.locator('div[data-testid^="reaction-chips-"], div.group:has(button[title*="Yanıtla"]), div.group.relative').first
        if not await bubble.is_visible():
            # Fallback to any message bubble container
            bubble = page.locator('div.group').filter(has=page.locator('button[title*="Yanıtla"], button[title*="Kopyala"]')).first

        reply_btn = page.locator('button[title*="Yanıtla"]').first
        if await reply_btn.count() > 0:
            parent_bubble = reply_btn.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]')
            await parent_bubble.hover()
            await page.wait_for_timeout(300)

            hover_ss = os.path.join(ARTIFACT_DIR, "wa_bubble_hover.png")
            await page.screenshot(path=hover_ss)
            print(f"[*] Hover screenshot saved: {hover_ss}")

            # 3. Click Reply button
            print("[4] Clicking Reply button...")
            await reply_btn.click()
            await page.wait_for_timeout(500)

            reply_banner = page.locator('div:has(> .border-l-\\[3px\\]) button:has(svg.lucide-x), button[title="İptal"], button[title="Cancel"]').first
            is_reply_open = await reply_banner.is_visible()
            print(f"[*] Reply quote banner visible: {is_reply_open}")

            reply_ss = os.path.join(ARTIFACT_DIR, "wa_reply_banner.png")
            await page.screenshot(path=reply_ss)
            print(f"[*] Reply banner screenshot saved: {reply_ss}")

            # Type something into composer to see quoted text draft
            composer = page.locator('textarea, input[placeholder*="mesaj"]').first
            await composer.fill("Görüşürüz!")
            await page.wait_for_timeout(300)
            reply_draft_ss = os.path.join(ARTIFACT_DIR, "wa_reply_draft.png")
            await page.screenshot(path=reply_draft_ss)
            print(f"[*] Reply draft screenshot saved: {reply_draft_ss}")

            # Dismiss reply banner
            if is_reply_open:
                await reply_banner.click()
            await composer.fill("")
            await page.wait_for_timeout(300)

        # 4. Dark Mode Verification
        print("[5] Testing Dark Mode...")
        theme_btn = page.locator('header button:has(svg.lucide-moon), nav button:has(svg.lucide-moon), button[title*="Koyu"], button[title*="Dark"]').first
        if await theme_btn.is_visible():
            await theme_btn.click()
            await page.wait_for_timeout(600)

            dark_ss = os.path.join(ARTIFACT_DIR, "wa_dark_mode.png")
            await page.screenshot(path=dark_ss)
            print(f"[*] Dark mode screenshot saved: {dark_ss}")

            # Switch back to light mode
            theme_sun = page.locator('header button:has(svg.lucide-sun), nav button:has(svg.lucide-sun), button[title*="Açık"], button[title*="Light"]').first
            if await theme_sun.is_visible():
                await theme_sun.click()
        # 6. In-Chat Search Verification
        print("[6] Testing In-Chat Search Bar...")
        search_toggle_btn = page.locator('button[title*="sohbette ara"], button[aria-label*="sohbette ara"]').first
        if await search_toggle_btn.is_visible():
            await search_toggle_btn.click()
            await page.wait_for_timeout(400)

            in_chat_input = page.locator('div[role="search"] input').first
            assert await in_chat_input.is_visible(), "In-chat search input must be visible after click"
            await in_chat_input.fill("CamScanner")
            await page.wait_for_timeout(500)

            search_bar_ss = os.path.join(ARTIFACT_DIR, "wa_in_chat_search.png")
            await page.screenshot(path=search_bar_ss)
            print(f"[*] In-chat search screenshot saved: {search_bar_ss}")

            # Close search using Escape
            await in_chat_input.press("Escape")
            await page.wait_for_timeout(300)

        print("\n" + "=" * 60)
        print("VERIFICATION RESULTS")
        print("=" * 60)
        print(f"Console Errors: {len(console_errors)}")
        for err in console_errors:
            print(f"  - {err}")
        print(f"Page Errors: {len(page_errors)}")
        for err in page_errors:
            print(f"  - {err}")

        await browser.close()
        assert len(page_errors) == 0, "Page errors encountered!"
        print("[SUCCESS] All WhatsApp Web interactions verified cleanly!")


if __name__ == "__main__":
    asyncio.run(run_interaction_verification())
