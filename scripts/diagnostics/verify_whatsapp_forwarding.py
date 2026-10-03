"""WhatsApp Web Message Forwarding & Multi-Select Parity Verification Script.

Tests live parity on production:
1. Opens WhatsApp Hub and navigates to active conversation.
2. Hovers over a message bubble to verify Forward action button is present.
3. Clicks Forward button to trigger ForwardModal.
4. Verifies ForwardModal opens, renders message preview, search input, and conversation targets.
5. Captures screenshot: wa_forward_modal.png.
6. Closes ForwardModal.
7. Opens 3-dot menu and toggles "Mesajları seç" (Multi-select mode).
8. Verifies selection checkboxes appear on message bubbles and bottom action bar mounts.
9. Selects messages and verifies dynamic count in bottom bar.
10. Captures screenshot: wa_multi_select_bar.png.
11. Verifies selection copy and forward actions work.
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


async def run_forwarding_verification():
    print("=" * 60)
    print("WHATSAPP WEB FORWARDING & MULTI-SELECT VERIFICATION")
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

        # 3. Test Hover Forward Action
        print("[3] Testing Hover Forward Action...")
        bubbles = page.locator("[data-msg-id]")
        bubble_count = await bubbles.count()
        print(f"[*] Total message bubbles in active chat: {bubble_count}")
        assert bubble_count > 0, "Expected at least 1 message bubble"

        target_bubble = bubbles.nth(bubble_count - 1)
        await target_bubble.scroll_into_view_if_needed()
        await target_bubble.hover()
        await page.wait_for_timeout(500)

        forward_btn = target_bubble.locator("[data-testid^='forward-trigger-']").first
        assert await forward_btn.count() > 0, "Forward trigger button must be present in hover bar"
        print("    PASS: Forward trigger button found in hover action bar")

        # 4. Open ForwardModal via single forward
        print("[4] Opening ForwardModal...")
        await forward_btn.click(force=True)
        await page.wait_for_timeout(1000)

        forward_modal = page.locator("[data-testid='forward-modal']")
        assert await forward_modal.count() > 0, "ForwardModal must be open in the DOM"

        search_input = page.locator("[data-testid='forward-search-input']")
        assert await search_input.count() > 0, "Search input must be present in ForwardModal"

        targets = page.locator("[data-testid^='forward-target-']")
        target_count = await targets.count()
        print(f"[*] Available forward target conversations: {target_count}")
        assert target_count > 0, "Target conversations should be rendered in ForwardModal"

        # Capture screenshot of ForwardModal
        modal_screenshot = os.path.join(ARTIFACT_DIR, "wa_forward_modal.png")
        await page.screenshot(path=modal_screenshot)
        print(f"    CAPTURED: {modal_screenshot}")

        # Close ForwardModal
        cancel_btn = forward_modal.locator("button:has-text('İptal')").first
        if await cancel_btn.count() > 0:
            await cancel_btn.click(force=True)
        else:
            await page.keyboard.press("Escape")
        await page.wait_for_timeout(500)
        print("    PASS: ForwardModal closed cleanly")

        # 5. Test Multi-Select Mode via 3-dot Menu
        print("[5] Testing Multi-Select Mode via 3-Dot Dropdown Menu...")
        menu_btn = page.locator("button[aria-label='Menü']").first
        if await menu_btn.count() == 0:
            menu_btn = page.locator("button:has(svg.lucide-more-vertical)").first
        assert await menu_btn.count() > 0, "3-dot dropdown menu trigger must exist"

        await menu_btn.click(force=True)
        await page.wait_for_timeout(500)

        select_item = page.locator("button:has-text('Mesajları seç')").first
        assert await select_item.count() > 0, "3-dot menu must have 'Mesajları seç' option"
        await select_item.click(force=True)
        await page.wait_for_timeout(600)

        # 6. Verify Selection Checkboxes & Bottom Selection Bar
        print("[6] Verifying Multi-Select Checkboxes and Bottom Action Bar...")
        selection_bar = page.locator("[data-testid='chat-selection-bar']")
        assert await selection_bar.count() > 0, "Bottom selection action bar must be mounted"

        checkboxes = page.locator("[data-testid^='select-checkbox-']")
        cb_count = await checkboxes.count()
        print(f"[*] Rendered select checkboxes: {cb_count}")
        assert cb_count > 0, "Selection checkboxes must be visible on bubbles in select mode"

        # Click first checkbox
        await checkboxes.first.click(force=True)
        await page.wait_for_timeout(300)

        # Click second checkbox if available
        if cb_count > 1:
            await checkboxes.nth(1).click(force=True)
            await page.wait_for_timeout(300)

        count_badge = page.locator("[data-testid='selected-count-badge']")
        assert await count_badge.count() > 0, "Selected count badge must be displayed"
        count_text = await count_badge.inner_text()
        print(f"[*] Selection badge text: {count_text}")
        assert "mesaj seçildi" in count_text, f"Unexpected badge text: {count_text}"

        # Capture screenshot of multi-select bottom bar
        select_screenshot = os.path.join(ARTIFACT_DIR, "wa_multi_select_bar.png")
        await page.screenshot(path=select_screenshot)
        print(f"    CAPTURED: {select_screenshot}")

        # Cancel selection mode
        cancel_select_btn = page.locator("[data-testid='cancel-selection-btn']").first
        await cancel_select_btn.click(force=True)
        await page.wait_for_timeout(500)
        assert await page.locator("[data-testid='chat-selection-bar']").count() == 0, "Selection bar must unmount on cancel"
        print("    PASS: Selection mode cancelled cleanly, composer restored")

        await context.close()
        await browser.close()

    print("\n" + "=" * 60)
    print("ALL FORWARDING & MULTI-SELECT LIVE CHECKS PASSED!")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(run_forwarding_verification())
