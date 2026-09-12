FROM python:3.12-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    ca-certificates \
    gnupg \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 (required by the bundled WhatsApp gateway / Baileys)
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
       | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
       > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# NOTE: No headless browser is installed on purpose.
# The default scraper engine is the zero-overhead pure-HTTP JSON engine
# (GoogleMapsHttpScraper, SCRAPER_ENGINE=HTTP) which needs only httpx (~15 MB RAM).
# Downloading Chromium (+ OS deps) would waste ~300 MB image size and push the
# Render 512 MB instance toward OOM. The `playwright` pip package stays in
# requirements.txt only so the optional fallback module still imports; the
# browser binary itself is intentionally absent. If the fallback engine is ever
# re-enabled (SCRAPER_ENGINE=PLAYWRIGHT), re-add:
#   RUN playwright install --with-deps chromium

# Copy backend source code and startup entrypoint
COPY backend/ ./backend/
COPY start.py .

# Copy the WhatsApp gateway (Baileys) and install its production deps.
# It runs as a sidecar process inside this same container so the backend can
# always reach it at 127.0.0.1:8787 (Render free plan has no private network
# across services unless paid; single-container keeps the QR flow working).
COPY whatsapp-gateway/package.json ./whatsapp-gateway/package.json
COPY whatsapp-gateway/src ./whatsapp-gateway/src
# The postinstall hook runs scripts/patch-baileys.mjs (Baileys LID/name fixes),
# so the scripts dir must exist before npm install.
COPY whatsapp-gateway/scripts ./whatsapp-gateway/scripts
RUN cd whatsapp-gateway && npm install --omit=dev --no-audit --no-fund
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1
ENV PORT=10000
ENV GATEWAY_HOST=127.0.0.1
ENV GATEWAY_PORT=8787
ENV BACKEND_WS_URL=ws://127.0.0.1:10000/ws/gateway

EXPOSE 10000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]