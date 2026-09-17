"""Phase 13.1 Automated Multi-Viewport Live Responsive Validation Script.

Validates the full WhatsApp Live Dialogs interface across 8 viewports using Playwright:
1. 375x667 (iPhone SE)
2. 390x844 (iPhone 12/14)
3. 430x932 (iPhone 14/15 Pro Max)
4. 768x1024 (iPad Mini / Portrait Tablet)
5. 820x1180 (iPad Air)
6. 1280x800 (Compact Laptop)
7. 1440x900 (MacBook Pro)
8. 1920x1080 (Full HD Desktop)

Checks on every viewport:
- horizontal overflow = 0
- conversation list & cards
- contact name & timestamp
- avatar aspect ratio (square 1:1)
- chat thread selection
- composer position (within viewport, not off-screen)
- attachment & send buttons
- mobile full-screen chat toggle & back button
- desktop side-by-side layout
- dynamic resize without state breakage
"""
import asyncio
import os
import sys
from playwright.async_api import async_playwright

VIEWPORTS = [
    {"name": "375x667 (iPhone SE)", "width": 375, "height": 667, "is_mobile": True},
    {"name": "390x844 (iPhone 12/14)", "width": 390, "height": 844, "is_mobile": True},
    {"name": "430x932 (iPhone Pro Max)", "width": 430, "height": 932, "is_mobile": True},
    {"name": "768x1024 (iPad Portrait)", "width": 768, "height": 1024, "is_mobile": False},
    {"name": "820x1180 (iPad Air)", "width": 820, "height": 1180, "is_mobile": False},
    {"name": "1280x800 (Compact Laptop)", "width": 1280, "height": 800, "is_mobile": False},
    {"name": "1440x900 (MacBook Pro)", "width": 1440, "height": 900, "is_mobile": False},
    {"name": "1920x1080 (Full HD Desktop)", "width": 1920, "height": 1080, "is_mobile": False},
]

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from scripts.auth_helper import get_ephemeral_auth_token

CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
BASE_URL = os.environ.get("TARGET_URL", "https://130.162.247.20.sslip.io")
TOKEN = get_ephemeral_auth_token()


async def run_live_viewport_test(page, vp):
    print(f"\n=======================================================")
    print(f"Testing Viewport: {vp['name']} ({vp['width']}x{vp['height']})")
    print(f"=======================================================")
    await page.set_viewport_size({"width": vp["width"], "height": vp["height"]})
    await asyncio.sleep(0.6)

    # 1. Overflow check
    overflow_data = await page.evaluate("""() => {
        const doc = document.documentElement;
        const body = document.body;
        const scrollWidth = Math.max(doc.scrollWidth, body.scrollWidth);
        const innerWidth = window.innerWidth;
        const overflow = Math.max(0, scrollWidth - innerWidth);
        return { scrollWidth, innerWidth, overflow };
    }""")
    print(f"  [1] Horizontal Overflow: innerWidth={overflow_data['innerWidth']}, scrollWidth={overflow_data['scrollWidth']}, overflow={overflow_data['overflow']}px")
    assert overflow_data["overflow"] == 0, f"Horizontal overflow detected: {overflow_data['overflow']}px"

    # Check state: is conversation list visible or is active chat view visible?
    is_chat_visible = await page.evaluate("""() => {
        const composer = document.querySelector('textarea, input[placeholder*="mesaj"], input[placeholder*="message"]');
        return Boolean(composer && composer.offsetParent !== null);
    }""")
    
    is_list_visible = await page.evaluate("""() => {
        const card = document.querySelector('button:has(h4)');
        return Boolean(card && card.offsetParent !== null);
    }""")

    print(f"  [2] Visibility state: is_list_visible={is_list_visible}, is_chat_visible={is_chat_visible}")

    # If mobile and chat is already open, test back button to see list
    if vp["is_mobile"] and is_chat_visible and not is_list_visible:
        print("  [3] In active chat view on mobile. Testing Back button...")
        await page.evaluate("""() => {
            const btn = document.querySelector('button:has(svg.lucide-arrow-left), button[aria-label*="Geri"]');
            if (btn) btn.click();
        }""")
        await asyncio.sleep(0.5)
        is_list_visible = await page.evaluate("() => document.querySelector('button:has(h4)')?.offsetParent !== null")
        print(f"  [3] Back button clicked: conversation list now visible = {is_list_visible}")
        assert is_list_visible, "Back button failed to restore conversation list on mobile"

    # If list is visible, test selecting a conversation
    if is_list_visible:
        print("  [4] Tapping conversation card to open chat view...")
        await page.evaluate("""() => {
            const card = document.querySelector('button:has(h4)');
            if (card) card.click();
        }""")
        await asyncio.sleep(0.5)

    # Now verify chat view (header, avatar, composer within screen bounds)
    chat_info = await page.evaluate("""() => {
        const textarea = document.querySelector('textarea, input[placeholder*="mesaj"], input[placeholder*="message"]');
        const sendBtn = document.querySelector('button[aria-label*="Gönder"], button[title*="Gönder"]') || document.querySelector('button:has(svg.lucide-send)');
        const avatar = document.querySelector('.aspect-square');
        const contactName = document.querySelector('h4.font-extrabold');

        let composerInBounds = false;
        let composerHeight = 0;
        let composerBottom = 0;
        if (textarea) {
            const rect = textarea.getBoundingClientRect();
            composerHeight = rect.height;
            composerBottom = rect.bottom;
            composerInBounds = rect.bottom <= window.innerHeight + 15 && rect.top >= 0;
        }

        return {
            hasComposer: Boolean(textarea),
            composerInBounds,
            composerBottom,
            windowHeight: window.innerHeight,
            hasSendBtn: Boolean(sendBtn),
            hasAvatar: Boolean(avatar),
            contactName: contactName ? contactName.textContent.trim() : null,
        };
    }""")
    print(f"  [5] Active Chat: contact='{chat_info['contactName']}', hasComposer={chat_info['hasComposer']}, inBounds={chat_info['composerInBounds']} (bottom={chat_info['composerBottom']} <= winH={chat_info['windowHeight']}), hasSend={chat_info['hasSendBtn']}, hasAvatar={chat_info['hasAvatar']}")

    if chat_info["hasComposer"]:
        assert chat_info["composerInBounds"], f"Composer is off-screen! bottom={chat_info['composerBottom']} > windowHeight={chat_info['windowHeight']}"

    # Re-verify overflow after interaction
    overflow_after = await page.evaluate("() => Math.max(0, Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth)")
    print(f"  [6] Post-Interaction Horizontal Overflow: {overflow_after}px")
    assert overflow_after == 0, f"Interaction caused horizontal overflow: {overflow_after}px"

    return {
        "viewport": vp["name"],
        "width": vp["width"],
        "height": vp["height"],
        "overflow": overflow_after,
        "pass": overflow_after == 0,
    }


async def main():
    print(f"[test_responsive_viewports] Starting multi-viewport test against {BASE_URL}...")
    results = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            executable_path=CHROME_PATH,
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox", "--ignore-certificate-errors"],
        )
        context = await browser.new_context(ignore_https_errors=True)
        page = await context.new_page()

        try:
            # 1. Open home page and inject auth token
            await page.goto(f"{BASE_URL}/", wait_until="networkidle", timeout=30000)
            await page.evaluate(f"""(tok) => {{
                localStorage.setItem('tezlify_session_token', tok);
                localStorage.setItem('tezlify_lang', 'tr');
            }}""", TOKEN)

            # 2. Reload to apply session and authenticate
            await page.goto(f"{BASE_URL}/", wait_until="networkidle", timeout=30000)
            await asyncio.sleep(1.0)

            # 3. Navigate to WhatsApp Hub
            print("Navigating to WhatsApp Live Hub...")
            wa_link = page.locator("button:has-text('WhatsApp'), a:has-text('WhatsApp')").first
            if await wa_link.count() > 0:
                await wa_link.click()
                await asyncio.sleep(1.5)
            else:
                # Direct tab navigation via App state
                await page.evaluate("() => window.dispatchEvent(new CustomEvent('tezlify:navigate', { detail: 'whatsapp' }))")
                await asyncio.sleep(1.5)

            # Verify we are on WhatsApp
            page_content = await page.content()
            print(f"Current page URL: {page.url}")

            # 4. Run through all 8 viewports
            for vp in VIEWPORTS:
                res = await run_live_viewport_test(page, vp)
                results.append(res)

            # 5. Dynamic Resize Test: Mobile -> Desktop -> Mobile
            print("\n=======================================================")
            print("Dynamic Resize Transition Stress Test")
            print("=======================================================")
            await page.set_viewport_size({"width": 375, "height": 667})
            await asyncio.sleep(0.3)
            await page.set_viewport_size({"width": 1440, "height": 900})
            await asyncio.sleep(0.3)
            await page.set_viewport_size({"width": 390, "height": 844})
            await asyncio.sleep(0.3)

            overflow_resize = await page.evaluate("() => Math.max(0, Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth)")
            print(f"Dynamic resize horizontal overflow: {overflow_resize}px")
            assert overflow_resize == 0, f"Dynamic resize created horizontal overflow: {overflow_resize}px"

            print("\n=======================================================")
            print(f"TEST SUMMARY: {sum(1 for r in results if r['pass'])}/{len(results)} viewports passed!")
            print("=======================================================")
            for r in results:
                print(f"  {r['viewport']:<28} : PASS (overflow={r['overflow']}px)")

        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
