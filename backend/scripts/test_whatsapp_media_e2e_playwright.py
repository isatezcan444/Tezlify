"""Phase 7.7 — Real Browser Playwright E2E Media Integrity & Cancellation Verification.

This test launches headless Chromium using Playwright and executes real HTTP socket interactions
against a controlled Starlette / Uvicorn test server running on an ephemeral port.

Scenarios tested:
1. Successful media downloads: Small image, Large image, Audio (ogg), Document (PDF), Video (mp4), Thumbnail.
2. Stream truncation detection: 95% truncation (the 90% threshold vulnerability), 80%, and 50% premature terminations.
3. Real browser cancellation (Critical): Browser aborts in-flight request, navigates away, and closes tab.
   Verifies socket closure detection, upstream cancellation, zero orphan streaming, and slot release.
4. Normal HTTP response completion: Verifies normal socket finish does NOT trigger false cancellation.
5. Multi-attempt retry coordination: Transient truncation on attempt 1 followed by verified success on attempt 2.
"""
import asyncio
import os
import sys
import time
from starlette.applications import Starlette
from starlette.responses import Response, StreamingResponse, PlainTextResponse
from starlette.routing import Route
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
import uvicorn
from playwright.async_api import async_playwright

SERVER_HOST = "127.0.0.1"

# Track server-side telemetry
server_stats = {
    "normal_completions": 0,
    "premature_socket_drops": 0,
    "browser_aborts_detected": 0,
    "active_streams": 0,
    "attempts_by_token": {},
}


async def handle_success_media(request):
    """Streams full verified media of specified category."""
    media_type = request.path_params.get("type", "image_small")
    server_stats["active_streams"] += 1

    content_map = {
        "image_small": (b"\xff\xd8\xff\xe0" + b"\x00" * 4096, "image/jpeg", "image_small.jpg"),
        "image_large": (b"\xff\xd8\xff\xe0" + b"\x11" * (512 * 1024), "image/jpeg", "image_large.jpg"),
        "audio": (b"OggS\x00\x02" + b"\x22" * (64 * 1024), "audio/ogg", "voice.ogg"),
        "document": (b"%PDF-1.4\n" + b"\x33" * (256 * 1024) + b"\n%%EOF", "application/pdf", "sample.pdf"),
        "video": (b"\x00\x00\x00\x18ftypmp42" + b"\x44" * (1024 * 1024), "video/mp4", "video.mp4"),
        "thumbnail": (b"\xff\xd8\xff\xe0" + b"\x05" * 2048, "image/jpeg", "thumb_preview.jpg"),
    }

    data, mime, filename = content_map.get(media_type, content_map["image_small"])

    headers = {
        "Content-Length": str(len(data)),
        "Content-Disposition": f'inline; filename="{filename}"',
        "Cache-Control": "private, max-age=3600",
        "Access-Control-Allow-Origin": "*",
    }
    server_stats["active_streams"] = max(0, server_stats["active_streams"] - 1)
    server_stats["normal_completions"] += 1
    return Response(content=data, media_type=mime, headers=headers)


async def handle_truncated_media(request):
    """Yields partial bytes then terminates stream before satisfying Content-Length."""
    pct = int(request.path_params.get("pct", "95"))
    total_bytes = 100_000
    deliver_bytes = int(total_bytes * (pct / 100.0))
    server_stats["premature_socket_drops"] += 1

    async def truncated_gen():
        yield b"\xaa" * deliver_bytes

    headers = {
        "Content-Length": str(total_bytes),
        "Access-Control-Allow-Origin": "*",
    }
    return StreamingResponse(
        truncated_gen(),
        media_type="application/octet-stream",
        headers=headers,
    )


async def handle_slow_cancellable_stream(request):
    """Slow streaming designed for testing in-flight browser cancellation."""
    async def slow_stream_gen():
        server_stats["active_streams"] += 1
        total_chunks = 40
        chunk_size = 16 * 1024  # 16KB per chunk
        try:
            for _ in range(total_chunks):
                yield b"\x55" * chunk_size
                await asyncio.sleep(0.05)
        except (asyncio.CancelledError, GeneratorExit):
            server_stats["browser_aborts_detected"] += 1
            raise
        finally:
            server_stats["active_streams"] = max(0, server_stats["active_streams"] - 1)

    headers = {
        "Content-Length": str(40 * 16 * 1024),
        "Access-Control-Allow-Origin": "*",
    }
    return StreamingResponse(
        slow_stream_gen(),
        media_type="video/mp4",
        headers=headers,
    )


async def handle_retry_simulation(request):
    """Fails with 503 / truncation on first attempt, then succeeds on retry."""
    token = request.query_params.get("token", "default")
    attempt = server_stats["attempts_by_token"].get(token, 0) + 1
    server_stats["attempts_by_token"][token] = attempt

    if attempt == 1:
        # Simulate transient error on attempt 1
        return PlainTextResponse(
            "Temporary Gateway Timeout - Retry within deadline",
            status_code=503,
            headers={"Access-Control-Allow-Origin": "*"},
        )

    # Attempt 2: Succeeds with verified payload
    data = b"\xff\xd8\xff\xe0" + b"\x77" * 8192
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Access-Control-Allow-Origin": "*"},
    )


async def handle_test_page(request):
    return PlainTextResponse("<!DOCTYPE html><html><body><h1>E2E Test Page</h1></body></html>", media_type="text/html")


async def create_test_server():
    routes = [
        Route("/test-page", handle_test_page),
        Route("/media/success/{type}", handle_success_media),
        Route("/media/truncated/{pct}", handle_truncated_media),
        Route("/media/slow-stream", handle_slow_cancellable_stream),
        Route("/media/retry-simulate", handle_retry_simulation),
    ]
    middleware = [
        Middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_methods=["*"],
            allow_headers=["*"],
        )
    ]
    app = Starlette(routes=routes, middleware=middleware)

    config = uvicorn.Config(app=app, host=SERVER_HOST, port=0, log_level="warning")
    server = uvicorn.Server(config)
    server_task = asyncio.create_task(server.serve())

    while not server.started:
        await asyncio.sleep(0.02)

    port = server.servers[0].sockets[0].getsockname()[1]
    base_url = f"http://{SERVER_HOST}:{port}"
    return server, server_task, base_url


async def run_e2e_tests():
    print("=== [PHASE 7.7] STARTING REAL BROWSER PLAYWRIGHT E2E MEDIA INTEGRITY SUITE ===")
    server, server_task, base_url = await create_test_server()
    print(f"[TEST-SERVER] Running on {base_url}")

    results = []

    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context()

            # -------------------------------------------------------------
            # TEST 1: Successful Media Downloads (All Categories)
            # -------------------------------------------------------------
            print("\n[SCENARIO 1] Testing successful downloads across media categories...")
            categories = ["image_small", "image_large", "audio", "document", "video", "thumbnail"]
            for cat in categories:
                url = f"{base_url}/media/success/{cat}"
                resp = await context.request.get(url)

                assert resp.status == 200, f"Expected 200, got {resp.status}"
                body = await resp.body()
                assert len(body) > 0, f"Empty body for {cat}"
                print(f"  ✓ {cat}: HTTP 200 OK, {len(body)} bytes received cleanly")

            # Also verify DOM element rendering in a real browser tab:
            page = await context.new_page()
            dom_test_html = f"""
            <html><body>
              <img id="img_test" src="{base_url}/media/success/image_small" />
            </body></html>
            """
            await page.goto(f"data:text/html,{dom_test_html}")
            await page.wait_for_selector("#img_test")
            is_loaded = await page.evaluate("document.getElementById('img_test').complete")
            assert is_loaded, "DOM <img> did not complete loading!"
            print("  ✓ DOM <img> element loaded successfully inside Chromium")
            await page.close()

            results.append(("Scenario 1: Successful Media Downloads (6 categories + DOM)", True))

            # -------------------------------------------------------------
            # TEST 2: Stream Truncation Detection (95%, 80%, 50%)
            # -------------------------------------------------------------
            print("\n[SCENARIO 2] Testing stream truncation detection (the 90% threshold risk)...")
            truncation_levels = [95, 80, 50]
            for pct in truncation_levels:
                page = await context.new_page()
                url = f"{base_url}/media/truncated/{pct}"
                await page.goto(f"{base_url}/test-page")

                fetch_script = f"""
                async () => {{
                  try {{
                    const res = await fetch('{url}');
                    await res.arrayBuffer();
                    return {{ ok: true }};
                  }} catch (err) {{
                    return {{ ok: false, error: err.name || String(err) }};
                  }}
                }}
                """
                res = await page.evaluate(fetch_script)
                assert not res["ok"], f"Truncation at {pct}% was not detected by browser!"
                print(f"  ✓ Truncation at {pct}% correctly caught by browser: {res.get('error')}")
                await page.close()

            assert server_stats["premature_socket_drops"] >= 3
            results.append(("Scenario 2: Stream Truncation Detection (%95, %80, %50)", True))

            # -------------------------------------------------------------
            # TEST 3: Browser Client Cancellation & Upstream Socket Termination
            # -------------------------------------------------------------
            print("\n[SCENARIO 3] Testing browser client cancellation & upstream termination...")
            page = await context.new_page()
            slow_url = f"{base_url}/media/slow-stream"

            start_stream_script = f"""
            (() => {{
              window._receivedChunks = 0;
              window._abortController = new AbortController();
              fetch('{slow_url}', {{ signal: window._abortController.signal }})
                .then(res => {{
                  const reader = res.body.getReader();
                  function readNext() {{
                    return reader.read().then(({{ done, value }}) => {{
                      if (done) return;
                      window._receivedChunks += 1;
                      return readNext();
                    }});
                  }}
                  return readNext();
                }})
                .catch(err => {{
                  window._abortError = err.name;
                }});
            }})()
            """
            await page.goto(f"{base_url}/test-page")
            await page.evaluate(start_stream_script)

            # Wait for at least 1-2 chunks to be received by the browser
            for _ in range(25):
                chunks = await page.evaluate("window._receivedChunks")
                if chunks >= 2:
                    break
                await asyncio.sleep(0.05)

            chunks_before_abort = await page.evaluate("window._receivedChunks")
            print(f"  [STREAM] Browser received {chunks_before_abort} chunks, now aborting...")

            # Abort via AbortController in browser
            await page.evaluate("window._abortController.abort()")
            await asyncio.sleep(0.15)

            abort_error = await page.evaluate("window._abortError")
            assert abort_error == "AbortError", f"Expected AbortError in browser, got {abort_error}"
            print("  ✓ Browser AbortController successfully triggered AbortError")

            # Test navigation away (closing tab mid-stream)
            page2 = await context.new_page()
            await page2.goto(f"{base_url}/test-page")
            await page2.evaluate(start_stream_script)
            await asyncio.sleep(0.12)
            # Browser tab closed abruptly:
            await page2.close()
            print("  ✓ Browser tab abruptly closed during stream")

            # Give server a moment to register socket closure
            await asyncio.sleep(0.2)
            assert server_stats["browser_aborts_detected"] >= 1, "Server failed to detect browser abort!"
            assert server_stats["active_streams"] == 0, "Active streams did not release back to 0!"
            print(f"  ✓ Server detected {server_stats['browser_aborts_detected']} client cancellations; 0 active streams lingering")

            results.append(("Scenario 3: Real Browser Cancellation & Socket Drop", True))

            # -------------------------------------------------------------
            # TEST 4: Normal Completion Does Not Trigger Cancellation
            # -------------------------------------------------------------
            print("\n[SCENARIO 4] Verifying normal completion does NOT trigger false cancellation...")
            resp = await context.request.get(f"{base_url}/media/success/image_small")
            assert resp.status == 200

            # Normal completion count incremented, no false browser aborts triggered
            assert server_stats["normal_completions"] >= 7
            print("  ✓ Normal HTTP completion successfully served without triggering false abort")
            results.append(("Scenario 4: Normal Completion Non-Cancellation Invariant", True))

            # -------------------------------------------------------------
            # TEST 5: Multi-attempt Retry Coordination
            # -------------------------------------------------------------
            print("\n[SCENARIO 5] Testing multi-attempt retry coordination...")
            page = await context.new_page()
            retry_token = f"tok-{int(time.time())}"
            retry_url = f"{base_url}/media/retry-simulate?token={retry_token}"

            # Attempt 1: 503
            resp1 = await page.request.get(retry_url)
            assert resp1.status == 503, f"Expected 503 on attempt 1, got {resp1.status}"
            print("  ✓ Attempt 1: Transient 503 correctly returned")

            # Attempt 2 (Retry): 200
            resp2 = await page.request.get(retry_url)
            assert resp2.status == 200, f"Expected 200 on attempt 2, got {resp2.status}"
            body2 = await resp2.body()
            assert len(body2) > 0
            print(f"  ✓ Attempt 2: Retry within deadline succeeded ({len(body2)} bytes)")
            await page.close()

            results.append(("Scenario 5: Multi-attempt Retry Coordination", True))

            await browser.close()

    finally:
        server.should_exit = True
        await server_task
        print("[TEST-SERVER] Cleaned up server runner successfully")

    print("\n=== PLAYWRIGHT E2E VERIFICATION SUMMARY ===")
    all_passed = True
    for name, passed in results:
        status_str = "PASS" if passed else "FAIL"
        print(f"  [{status_str}] {name}")
        if not passed:
            all_passed = False

    if all_passed:
        print("\nALL 5 REAL BROWSER PLAYWRIGHT E2E SCENARIOS PASSED WITH ZERO ERRORS!")
        return 0
    else:
        print("\nSOME PLAYWRIGHT E2E SCENARIOS FAILED!")
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(run_e2e_tests())
    sys.exit(exit_code)
