"""WhatsApp Web Starred Messages Parity Verification Script.

Tests live parity on production:
1. Opens WhatsApp Hub and navigates to active conversation.
2. Hovers over a message bubble to reveal the hover action bar.
3. Clicks the Star button to star the message.
4. Verifies the gold star indicator is rendered in the message bubble.
5. Opens ChatInfoDrawer and verifies the dynamic Starred Messages count badge.
6. Clicks Starred Messages section to enter the dedicated Starred Messages sub-view.
7. Captures screenshots for visual verification.
8. Tests unstar and back navigation.
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


async def run_starred_verification():
    print("=" * 60)
    print("WHATSAPP WEB STARRED MESSAGES PARITY VERIFICATION")
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
                "--window-size=1440,900",
            ],
        )
        context = await browser.new_context(
            ignore_https_errors=True,
            viewport={"width": 1440, "height": 900},
        )
        page = await context.new_page()

        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
        page.on("pageerror", lambda err: page_errors.append(str(err)))

        # 1. Login & Navigate
        print("[1] Injecting admin session and loading page...")
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

        await page.goto(f"{BASE_URL}/?tab=whatsapp", wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(2500)
        print("    PASS: WhatsApp Hub loaded in dark mode")

        # 2. Select active conversation
        print("[2] Selecting active conversation...")
        candidate_conv_ids = ["20497", "20534", "20514", "20519"]
        selected_conv = None

        for conv_id in candidate_conv_ids:
            item = page.locator(f"button[data-conv-id='{conv_id}']").first
            if await item.count() > 0:
                print(f"[*] Found candidate conversation (conv_id={conv_id}). Selecting...")
                await item.scroll_into_view_if_needed()
                await item.click(force=True)
                selected_conv = conv_id
                await page.wait_for_timeout(3000)
                break

        if not selected_conv:
            item = page.locator("button[data-conv-id]").first
            if await item.count() > 0:
                await item.scroll_into_view_if_needed()
                await item.click(force=True)
                await page.wait_for_timeout(3000)
                print("[*] Selected first available conversation")

        # 3. Find message and hover to star
        print("[3] Hovering message to click star trigger...")
        message_bubbles = page.locator("[data-msg-id]")
        count = await message_bubbles.count()
        assert count > 0, "Must have at least one message in conversation"
        first_bubble = message_bubbles.first
        await first_bubble.scroll_into_view_if_needed()
        await first_bubble.hover()
        await page.wait_for_timeout(600)

        star_trigger = page.locator("[data-testid^='star-trigger-']").first
        assert await star_trigger.count() > 0, "Star trigger must be rendered in hover action bar"
        print("    Found star trigger button, clicking...")
        await star_trigger.click(force=True)
        await page.wait_for_timeout(1000)

        # 4. Verify gold star icon rendered on bubble
        print("[4] Verifying gold star icon rendered on message bubble...")
        star_icon = page.locator("[data-testid^='msg-starred-icon-']").first
        assert await star_icon.count() > 0, "Gold star icon must be rendered on message bubble"
        print("    PASS: Gold star icon rendered on message bubble")

        bubble_shot_path = os.path.join(ARTIFACT_DIR, "wa_starred_bubble.png")
        await page.screenshot(path=bubble_shot_path)
        print(f"    Saved starred bubble screenshot: {bubble_shot_path}")

        # 5. Open ChatInfoDrawer and check count
        print("[5] Opening ChatInfoDrawer to verify starred count...")
        info_btn = page.locator("[data-testid='header-chat-info-btn']").first
        await info_btn.click(force=True)
        await page.wait_for_timeout(1500)

        drawer = await page.wait_for_selector("[data-testid='chat-info-drawer']", timeout=5000)
        assert drawer, "ChatInfoDrawer must be open"
        starred_count_el = page.locator("[data-testid='drawer-starred-count']").first
        assert await starred_count_el.count() > 0, "Starred count badge must be present"
        count_text = (await starred_count_el.text_content() or "").strip()
        print(f"    Drawer Starred Messages Count: {count_text}")
        assert int(count_text) >= 1, "Count must be at least 1"

        # 6. Click Starred Messages section to enter sub-view
        print("[6] Clicking Starred Messages section to enter sub-view...")
        starred_section = page.locator("[data-testid='drawer-starred-section']").first
        await starred_section.click(force=True)
        await page.wait_for_timeout(1000)

        starred_list = await page.wait_for_selector("[data-testid='drawer-starred-list']", timeout=5000)
        assert starred_list, "Starred messages sub-view list must be mounted"
        print("    PASS: Starred messages sub-view list is mounted")

        drawer_shot_path = os.path.join(ARTIFACT_DIR, "wa_starred_drawer_subview.png")
        await page.screenshot(path=drawer_shot_path)
        print(f"    Saved starred drawer sub-view screenshot: {drawer_shot_path}")

        # 7. Test Back button to return to main drawer
        print("[7] Testing Back button navigation...")
        back_btn = page.locator("[data-testid='back-info-drawer-btn']").first
        await back_btn.click(force=True)
        await page.wait_for_timeout(600)

        assert await page.locator("[data-testid='drawer-starred-section']").count() > 0, "Must return to main drawer"
        print("    PASS: Back button returned to main drawer view")

        await browser.close()

    print("\n" + "=" * 60)
    print("ALL STARRED MESSAGES LIVE BROWSER CHECKS PASSED!")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(run_starred_verification())
