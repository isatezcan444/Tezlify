# WhatsApp — open findings

Live-test findings that are not yet fixed. Written down so they are not lost;
each one is unverified in the browser and needs a real session to confirm.

## 1. "Load older messages" button is unreachable by design

`frontend/src/features/whatsapp/components/ChatThread.tsx:900`

```jsx
{win.start <= 0 && hasMore && loadOlderButton}
```

The control renders only when the virtualized window has scrolled to the very
top (`win.start <= 0`). The scroll handler triggers the same load at
`scrollTop < 60`, so by the time the button is visible the scroll path has
already fired it — the button has no independent use, and with the K.19
virtualization (K19_MIN_ROWS = 200) it stays hidden for most of a long thread.

The pagination itself is fixed (provider exhaustion no longer hides stored
history — see a95fb8e). This is about the affordance, not the fetch.

Needs a decision: either render the control inside the window (at the top of
the first mounted row) so it is usable, or drop it and rely on the scroll
trigger. Requires a browser session to confirm the current behaviour.

## 2. Scroll-anchor preservation has no real test

The existing `frontend/scripts/test-whatsapp-chat-scroll.mjs` asserts the
arithmetic of the height-delta trick against a hand-written object literal. It
never mounts ChatThread and would keep passing if the component stopped pinning
entirely.

A real JSDOM test was attempted and abandoned rather than committed. Findings
from that attempt, which are the hard part of writing it:

- The virtualized path only engages above K19_MIN_ROWS = 200 rows. A small
  fixture silently exercises the legacy height-delta path instead, so the suite
  would test the wrong code while appearing to pass.
- The bundle must export React, createRoot and I18nProvider from the same
  bundle as ChatThread; rendering against a second React instance throws
  "Invalid hook call". `verify-whatsapp-dom.mjs` already does this — follow it.
- JSDOM needs shims for `ResizeObserver` (a no-op leaves every row unmeasured
  and the window never fills), `scrollIntoView` and `scrollTo`.
- The component reads Vite's `import.meta.env` at module scope; `define` it in
  esbuild.
- Row rects must be computed on every `getBoundingClientRect` call. A captured
  rect keeps the geometry from capture time, and the test then validates nothing.
- The leading spacer must be read from the rendered `div[aria-hidden]`'s inline
  height rather than recomputed.
- `scrollTop` must have a single owner. An earlier version had the harness write
  to a dataset while the component read an accessor, so the two diverged.

With those in place the component mounts and the virtualizer runs, but the
resulting assertion was red with a 50-row offset that could not be attributed
with confidence to the component rather than the harness's height model. Left
uncommitted rather than committed failing or, worse, committed passing for the
wrong reason.

## 3. Unverified

- Real A -> B -> C -> A conversation switching.
- Group chats.
- Physical iOS keyboard behaviour (safe-area, viewport resize).
