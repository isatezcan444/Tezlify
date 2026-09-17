import asyncio
import os
import sys
from playwright.async_api import async_playwright

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from scripts.auth_helper import get_ephemeral_auth_token

BASE_URL = os.environ.get("TARGET_URL", "https://app.tezlify.com")
CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ARTIFACT_DIR = "/Users/isatezcan/.gemini/antigravity-ide/brain/43b7cb5b-a5e1-4b66-8da7-0943bb9ba2a8"


async def main():
    token = get_ephemeral_auth_token()
    print(f"[Auth] Ephemeral token obtained.")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            executable_path=CHROME_PATH,
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--ignore-certificate-errors",
                "--host-resolver-rules=MAP app.tezlify.com 130.162.247.20",
            ],
        )
        context = await browser.new_context(
            ignore_https_errors=True,
            viewport={"width": 1440, "height": 900},
        )
        page = await context.new_page()

        # Set localStorage token
        await page.goto(f"{BASE_URL}/", wait_until="networkidle", timeout=30000)
        await page.evaluate(f"""(tok) => {{
            localStorage.setItem('tezlify_session_token', tok);
            localStorage.setItem('tezlify_lang', 'tr');
        }}""", token)
        await page.goto(f"{BASE_URL}/", wait_until="networkidle", timeout=30000)
        await asyncio.sleep(1.0)

        print("[Navigation] Navigating to WhatsApp Hub...")
        wa_btn = page.locator('button[data-tab-id="whatsapp"]').first
        await wa_btn.wait_for(state="visible", timeout=10000)
        await wa_btn.click()
        await asyncio.sleep(3.0)

        # Wait for conversation list to render
        await page.wait_for_selector("button:has(h4)", timeout=15000)
        await asyncio.sleep(2)

        # Extract all visible conversation names and previews
        conversations = await page.evaluate("""() => {
            const buttons = Array.from(document.querySelectorAll('button:has(h4)'));
            return buttons.map(btn => {
                const h4 = btn.querySelector('h4');
                const name = h4 ? h4.textContent.trim() : '';
                const p = btn.querySelector('p');
                const preview = p ? p.textContent.trim() : '';
                return { name, preview };
            });
        }""")

        print(f"[DOM] Extracted {len(conversations)} conversations from DOM:")
        for idx, c in enumerate(conversations[:25], 1):
            print(f"  {idx:2d}. {c['name']:<25} | {c['preview']}")

        ghost_cards = [c for c in conversations if "Kişi kimliği" in c['name'] or "@lid" in c['name']]
        print(f"\\n[DOM] Ghost cards found: {len(ghost_cards)}")
        for gc in ghost_cards:
            print(f"  GHOST: {gc}")

        # Capture screenshot of sidebar
        screenshot_path = os.path.join(ARTIFACT_DIR, "live_dialogues_clean.png")
        await page.screenshot(path=screenshot_path, full_page=False)
        print(f"[Screenshot] Saved to {screenshot_path}")

        # Assert zero ghost cards
        assert len(ghost_cards) == 0, f"Expected 0 ghost cards, found {len(ghost_cards)}: {ghost_cards}"
        print("[SUCCESS] Zero ghost LID cards in DOM! Live dialogues list is completely clean.")

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
