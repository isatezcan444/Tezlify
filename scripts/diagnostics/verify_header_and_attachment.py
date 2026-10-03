import asyncio
import os
import sys
from playwright.async_api import async_playwright

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)
from scripts.auth_helper import get_ephemeral_auth_token

BASE_URL = os.environ.get("TARGET_URL", "https://130.162.247.20.sslip.io")
CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ARTIFACT_DIR = "/Users/isatezcan/.gemini/antigravity-ide/brain/7c08a75b-8c18-4648-9667-77c7d256d21e"

async def capture_header_and_attachment():
    token = get_ephemeral_auth_token()
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            executable_path=CHROME_PATH,
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox", "--ignore-certificate-errors", "--window-size=1440,900"],
        )
        context = await browser.new_context(ignore_https_errors=True, viewport={"width": 1440, "height": 900})
        page = await context.new_page()

        await page.goto(f"{BASE_URL}/", wait_until="commit", timeout=30000)
        await page.evaluate(f"""(tok) => {{
            localStorage.setItem('tezlify_session_token', tok);
            localStorage.setItem('tezlify_theme', 'light');
            localStorage.setItem('tezlify_lang', 'tr');
            document.documentElement.classList.remove('dark');
        }}""", token)

        await page.goto(f"{BASE_URL}/?tab=whatsapp", wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(2000)

        # Select first conversation
        first_item = page.locator("button[data-conv-id]").first
        if await first_item.count() > 0:
            await first_item.click()
            await page.wait_for_timeout(1500)

        # 1. Capture Header
        header = page.locator("header").first
        await page.screenshot(path=os.path.join(ARTIFACT_DIR, "wa_header_clean.png"))
        print("[*] Captured header screenshot: wa_header_clean.png")

        # 2. Click Attachment Button to show options
        attach_btn = page.locator("button[aria-label='Fotoğraf veya Belge Ekle']").first
        if await attach_btn.count() > 0:
            await attach_btn.click()
            await page.wait_for_timeout(500)
            await page.screenshot(path=os.path.join(ARTIFACT_DIR, "wa_attachment_menu.png"))
            print("[*] Captured attachment menu screenshot: wa_attachment_menu.png")

        await browser.close()

if __name__ == "__main__":
    asyncio.run(capture_header_and_attachment())
