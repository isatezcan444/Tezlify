FROM python:3.12-slim

WORKDIR /app

# Install minimal system dependencies for building C extensions and healthcheck.
#
# The Operations Center needs the docker CLI (no daemon) to run ALLOWLISTED
# `docker compose` operations against the mounted host socket
# (/var/run/docker.sock). It is NOT a general command runner — every operation
# is a fixed, code-defined action in backend/app/services/admin/ops_service.py,
# never caller-supplied argv. Installing only the client keeps the attack
# surface minimal; the socket mount is what actually grants host access and is
# granted deliberately in docker-compose.prod.yml.
#
# Package split (Debian trixie): `docker.io` installs the DAEMON and only
# contributes /usr/bin/docker-init — it does NOT ship the client binary. The
# CLI lives in `docker-cli`. Installing only `docker.io` produces an image where
# `docker` is "executable file not found", so both are required.
#
# `docker compose` is a CLI PLUGIN, and this base image ships no plugin dir at
# all, so the subcommand is unavailable even with the CLI installed. The
# standalone `docker-compose` v2 package provides it (the package is
# `docker-compose`; `docker-compose-v2` does not exist on this image).
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    ca-certificates \
    docker.io \
    docker-cli \
    docker-compose \
    && rm -rf /var/lib/apt/lists/*

# Fail the build, not production, if either tool is missing: without them every
# Operations Center action would fail at runtime with a confusing message.
RUN docker --version && docker compose version

# Copy requirements and install
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend source code and startup runner
COPY backend/ ./backend/
COPY start.py .

ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1
ENV PORT=8000

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"

CMD ["python3", "start.py"]
