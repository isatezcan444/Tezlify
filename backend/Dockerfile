FROM python:3.12-slim

WORKDIR /app

# Install minimal system dependencies for building C extensions and healthcheck.
#
# `docker.io` is the CLI only (no daemon): the Operations Center needs to run
# ALLOWLISTED `docker compose` operations against the mounted host socket
# (/var/run/docker.sock). It is NOT a general command runner — every operation
# is a fixed, code-defined action in backend/app/services/admin/ops_service.py,
# never caller-supplied argv. Installing only the client keeps the attack
# surface minimal; the socket mount is what actually grants host access and is
# granted deliberately in docker-compose.prod.yml.
#
# The compose PLUGIN is not installed: `docker.io` ships the CLI, and the
# daemon's built-in `docker compose` subcommand is what the operations invoke.
# (The `docker-compose-v2` apt package does not exist on this base image.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    ca-certificates \
    docker.io \
    && rm -rf /var/lib/apt/lists/*

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
