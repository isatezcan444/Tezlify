import asyncio
import os
import sys
from playwright.async_api import async_playwright

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, REPO_ROOT)
try:
    from scripts.auth_helper import get_ephemeral_auth_token
except ImportError:
    from auth_helper import get_ephemeral_auth_token

BASE_URL = os.environ.get("TARGET_URL", "https://130.162.247.20.sslip.io")
CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

async def debug_voice():
    token = get_ephemeral_auth_token()
    console_logs = []
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            executable_path=CHROME_PATH,
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox", "--ignore-certificate-errors", "--window-size=1440,900"],
        )
        context = await browser.new_context(ignore_https_errors=True, viewport={"width": 1440, "height": 900})
        page = await context.new_page()

        page.on("console", lambda msg: console_logs.append(f"[{msg.type}] {msg.text}"))
        page.on("requestfailed", lambda req: console_logs.append(f"[REQ_FAILED] {req.method} {req.url} -> {req.failure}"))

        await page.goto(f"{BASE_URL}/", wait_until="commit", timeout=30000)
        await page.evaluate(f"""(tok) => {{
            localStorage.setItem('tezlify_session_token', tok);
            localStorage.setItem('tezlify_theme', 'dark');
            document.documentElement.classList.add('dark');
        }}""", token)

        await page.goto(f"{BASE_URL}/?tab=whatsapp", wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(2000)

        # Select conversation 20633
        conv_btn = page.locator("button[data-conv-id='20633']").first
        if await conv_btn.count() == 0:
            print("Conversation 20633 not found in list, searching...")
            conv_btn = page.locator("button[data-conv-id]").first
        
        await conv_btn.click()
        await page.wait_for_timeout(2500)

        # Inspect all audio tags in the page
        audio_info = await page.evaluate("""() => {
            const audios = Array.from(document.querySelectorAll('audio'));
            return audios.map(a => ({
                src: a.src,
                currentSrc: a.currentSrc,
                error: a.error ? { code: a.error.code, message: a.error.message } : null,
                networkState: a.networkState,
                readyState: a.readyState,
                duration: a.duration,
                paused: a.paused
            }));
        }""")
        print("Audio tags info:", audio_info)

        # Check if VoiceNotePlayer or error element is rendered
        voice_players = await page.locator("audio").count()
        print(f"Total <audio> elements found: {voice_players}")
        
        error_alerts = await page.locator("text='Medya yüklenemedi'").count()
        print(f"Medya yüklenemedi alerts count: {error_alerts}")

        # Try clicking play on first voice note if available
        play_btn = page.locator("button[aria-label='Oynat'], button[aria-label='Play']").first
        if await play_btn.count() > 0:
            print("Clicking Play button...")
            await play_btn.click()
            await page.wait_for_timeout(2000)
            
            after_click = await page.evaluate("""() => {
                const audios = Array.from(document.querySelectorAll('audio'));
                return audios.map(a => ({
                    src: a.src,
                    error: a.error ? { code: a.error.code, message: a.error.message } : null,
                    currentTime: a.currentTime,
                    paused: a.paused
                }));
            }""")
            print("After play click audio info:", after_click)

        print("\n--- Console Logs ---")
        for log in console_logs[-30:]:
            print(log)

        await browser.close()

if __name__ == "__main__":
    asyncio.run(debug_voice())
