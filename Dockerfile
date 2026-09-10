FROM python:3.12-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
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

ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1
ENV PORT=10000

EXPOSE 10000

CMD ["python", "start.py"]