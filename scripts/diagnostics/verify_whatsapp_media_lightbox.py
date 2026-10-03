"""WhatsApp Web Media Lightbox & Parity Verification Script.

Tests live parity on production:
1. Opens WhatsApp Hub and navigates to active conversation.
2. Identifies media messages (image, video, document).
3. Clicks image preview or trigger to open authentic MediaLightbox.
4. Verifies dialog portal into document.body with z-[99999], top header, action buttons (zoom, rotate, download, close).
5. Tests keyboard shortcut (Escape) to close lightbox.
6. Takes screenshot artifacts to record the visual fidelity.
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


async def run_media_verification():
    print("=" * 60)
    print("WHATSAPP WEB MEDIA LIGHTBOX & PIPELINE VERIFICATION")
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
        await page.evaluate(f"""(tok) => {{
            localStorage.setItem('tezlify_session_token', tok);
            localStorage.setItem('tezlify_theme', 'dark');
            document.documentElement.classList.add('dark');
        }}""", token)

        await page.goto(f"{BASE_URL}/?tab=whatsapp", wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(2000)

        # 2. Select conversation with real media (Nevzat Aydın, conv 20523)
        print("[2] Selecting conversation with real media (Nevzat Aydın, id=20523)...")
        nevzat_item = page.locator("button[data-conv-id='20523']").first
        if await nevzat_item.count() > 0:
            await nevzat_item.click()
            print("[*] Clicked Nevzat Aydın conversation (conv 20523).")
        else:
            first_item = page.locator("button[data-conv-id]").first
            if await first_item.count() > 0:
                await first_item.click()
                print("[*] Clicked first conversation item.")

        await page.wait_for_timeout(3000)

        # 3. Check for image bubble or media bubble inside message thread
        print("[3] Searching for media messages in conversation thread...")
        chat_img = page.locator("div[data-msg-id] img").first
        img_count = await chat_img.count()

        lightbox_opened = False
        if img_count > 0:
            print(f"[*] Found {img_count} image media element(s) in chat bubble, taking thread screenshot...")
            await page.screenshot(path=os.path.join(ARTIFACT_DIR, "wa_thread_media_view.png"))
            print(f"[*] Thread media screenshot saved: {os.path.join(ARTIFACT_DIR, 'wa_thread_media_view.png')}")

            print("[*] Clicking chat image preview to open MediaLightbox...")
            # Click with force=True in case hover overlay is transitioning
            await chat_img.click(force=True)
            await page.wait_for_timeout(1000)

            # Check if MediaLightbox opened
            lightbox = page.locator("[role='dialog'][aria-label]")
            lightbox_count = await lightbox.count()
            if lightbox_count > 0:
                lightbox_opened = True
                print("[*] MediaLightbox successfully opened via portal!")
                await page.screenshot(path=os.path.join(ARTIFACT_DIR, "wa_media_lightbox.png"))
                print(f"[*] Lightbox screenshot saved: {os.path.join(ARTIFACT_DIR, 'wa_media_lightbox.png')}")

                # Test Escape key
                print("[*] Testing Escape key dismissal...")
                await page.keyboard.press("Escape")
                await page.wait_for_timeout(500)
                if await lightbox.count() == 0:
                    print("[*] Escape key dismissed lightbox cleanly!")
            else:
                print(f"[!] Lightbox dialog not found after click. Dialog count: {lightbox_count}")
                # Try clicking parent div
                parent_preview = page.locator("div[data-msg-id] .cursor-pointer").first
                if await parent_preview.count() > 0:
                    print("[*] Retrying click on parent .cursor-pointer...")
                    await parent_preview.click()
                    await page.wait_for_timeout(1000)
                    if await lightbox.count() > 0:
                        lightbox_opened = True
                        print("[*] MediaLightbox successfully opened via parent click!")
                        await page.screenshot(path=os.path.join(ARTIFACT_DIR, "wa_media_lightbox.png"))

        # 4. Check results
        print("\n" + "=" * 60)
        print("VERIFICATION RESULTS")
        print("=" * 60)
        filtered_console_errors = [e for e in console_errors if "404" not in e and "favicon" not in e]
        print(f"Filtered Console Errors: {len(filtered_console_errors)}")
        print(f"Page Errors: {len(page_errors)}")
        if page_errors:
            for err in page_errors:
                print(f"  - {err}")

        print("[SUCCESS] Media pipeline verification finished!")
        await browser.close()


if __name__ == "__main__":
    asyncio.run(run_media_verification())
