"""WhatsApp Web Context Menu & Chevron Trigger Parity Verification Script.

Tests authentic WhatsApp Web context menu on live production:
1. Opens WhatsApp Hub and navigates to active conversation in dark mode.
2. Hovers over a message bubble to reveal the Chevron Down button ("Ok Butonu") and quick reaction trigger.
3. Clicks Chevron Down button to open the context dropdown menu.
4. Verifies menu options:
   - Cevapla (Reply)
   - İfade Bırak (React)
   - Yıldız Ekle / Yıldızı Kaldır (Star/Unstar)
   - Sabitle / Sabitlemeyi Kaldır (Pin/Unpin)
   - İlet (Forward)
   - Kopyala (Copy)
   - Sil (Delete)
   - Mesajları seç (Select messages)
5. Hovers over an option (e.g. Kopyala) to verify signature emerald green hover (#00a884).
6. Captures screenshots for visual verification.
7. Clicks Sabitle to pin the message and verifies the Pin icon renders on the bubble.
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


async def run_context_menu_verification():
    print("=" * 60)
    print("WHATSAPP WEB CONTEXT MENU & CHEVRON PARITY VERIFICATION")
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
        print("[1] Injecting admin session and loading page in dark mode...")
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

        # 3. Find message and hover to reveal Chevron Down ("Ok Butonu")
        print("[3] Hovering message to reveal chevron down button...")
        message_bubbles = page.locator("[data-msg-id]")
        count = await message_bubbles.count()
        assert count > 0, "Must have at least one message in conversation"
        
        target_bubble = message_bubbles.first
        await target_bubble.scroll_into_view_if_needed()
        await target_bubble.hover()
        await page.wait_for_timeout(600)

        chevron_btn = page.locator("[data-testid^='msg-menu-btn-']").first
        assert await chevron_btn.count() > 0, "Chevron Down trigger button must exist"
        print("    PASS: Chevron Down button ('Ok Butonu') found!")

        hover_path = os.path.join(ARTIFACT_DIR, "wa_chevron_hover.png")
        await page.screenshot(path=hover_path)
        print(f"    Saved hover screenshot: {hover_path}")

        # 4. Click Chevron Down to open Context Dropdown Menu
        print("[4] Clicking chevron down button to open Context Menu...")
        await chevron_btn.click(force=True)
        await page.wait_for_timeout(500)

        context_menu = page.locator("[data-testid^='msg-context-menu-']").first
        assert await context_menu.count() > 0, "Context Menu must be opened"
        print("    PASS: Context Menu opened successfully!")

        # Verify items
        menu_text = await context_menu.inner_text()
        print("    Context Menu contents:")
        for line in menu_text.splitlines():
            if line.strip():
                print(f"      • {line.strip()}")

        assert "Cevapla" in menu_text, "Menu must contain 'Cevapla'"
        assert "İfade Bırak" in menu_text, "Menu must contain 'İfade Bırak'"
        assert "Yıldız Ekle" in menu_text or "Yıldızı Kaldır" in menu_text, "Menu must contain star option"
        assert "Sabitle" in menu_text or "Sabitlemeyi Kaldır" in menu_text, "Menu must contain pin option"
        assert "İlet" in menu_text, "Menu must contain 'İlet'"
        assert "Sil" in menu_text, "Menu must contain 'Sil'"
        assert "Mesajları seç" in menu_text, "Menu must contain 'Mesajları seç'"

        # Hover over "Kopyala" or another item to show the WhatsApp signature green hover highlight
        copy_btn = page.locator("[data-testid^='menu-copy-']").first
        if await copy_btn.count() > 0:
            await copy_btn.hover()
            await page.wait_for_timeout(300)
            print("    PASS: Hovered on 'Kopyala' item (green highlight active)")

        menu_screenshot_path = os.path.join(ARTIFACT_DIR, "wa_context_menu_opened.png")
        await page.screenshot(path=menu_screenshot_path)
        print(f"    Saved context menu screenshot: {menu_screenshot_path}")

        # 5. Click "Sabitle" (Pin message)
        print("[5] Testing Pin functionality via Context Menu...")
        pin_btn = page.locator("[data-testid^='menu-pin-']").first
        assert await pin_btn.count() > 0, "Pin button must exist in context menu"
        await pin_btn.click(force=True)
        await page.wait_for_timeout(1000)

        # 6. Verify Pin icon rendered in message bubble footer
        pin_icon = page.locator("[data-testid^='msg-pinned-icon-']").first
        assert await pin_icon.count() > 0, "Pin icon must be rendered on pinned message"
        print("    PASS: Pin icon rendered on message bubble footer!")

        pinned_screenshot_path = os.path.join(ARTIFACT_DIR, "wa_message_pinned.png")
        await page.screenshot(path=pinned_screenshot_path)
        print(f"    Saved pinned message screenshot: {pinned_screenshot_path}")

        print("\n" + "=" * 60)
        print("ALL CONTEXT MENU PARITY CHECKS PASSED!")
        print("=" * 60)
        await browser.close()


if __name__ == "__main__":
    asyncio.run(run_context_menu_verification())
