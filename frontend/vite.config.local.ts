import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Phase 6.6 real-stack config (UNTRACKED on purpose — see the phase's DO-NOT-COMMIT rule).
//
// Why this exists: `frontend/.env` points the dev server at PRODUCTION
// (`VITE_API_URL=https://api.130.162.247.20.sslip.io`), and `AuthContext`
// fetches a RELATIVE `/api/v1/auth/me` that no cross-origin VITE_API_URL can
// reach. So the local stack must be same-origin, exactly like production where
// Caddy proxies /api and /ws to the FastAPI container.
//
// With this config the browser talks to ONE origin (127.0.0.1:5173) and every
// hop is explicit:
//   browser :5173  --/api-->  FastAPI :8000  --HTTP-->  gateway :8787 --WSS--> WhatsApp
//   browser :5173  --/ws---->  FastAPI :8000  (backend pushes UI events here)
//   gateway        --/ws/gateway--> FastAPI :8000
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
    },
  },
})
