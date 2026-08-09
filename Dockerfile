# syntax=docker/dockerfile:1

# FPS ARENA X — one image, one process, one free Render service.
#
# The client is a static bundle and the relay is Python, so the build is a
# two-stage affair: Node compiles the bundle, then it is copied into a Python
# runtime and the Node toolchain is thrown away. The runtime image carries no
# npm, no node_modules and no source — which is the whole point, because on a
# free instance the image pull is part of every cold start, and every megabyte
# of build tooling is latency paid by the player who wakes the service up.

# ---------------------------------------------------------------- 1. build the client
FROM node:22-alpine AS client

# libc6-compat is what lets the prebuilt native binaries in the Next toolchain
# run on Alpine's musl; without it `next build` dies on an ELF load error.
RUN apk add --no-cache libc6-compat

WORKDIR /build
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# Manifest first: this layer is cached until a dependency actually changes, so
# ordinary gameplay commits rebuild in seconds instead of re-resolving the tree.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

COPY . .

# `output: 'export'` in next.config.mjs makes this write ./out — a plain tree of
# HTML, JS and assets with no Node server behind it.
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm exec next build

# ---------------------------------------------------------------- 2. runtime
FROM python:3.12-slim AS runtime

# PYTHONUNBUFFERED matters more than it looks: without it Render's log stream
# shows nothing until a buffer flushes, and a cold start you cannot see is a
# cold start you cannot debug.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=10000

WORKDIR /app

COPY server/requirements.txt ./server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt

COPY server/ ./server/
COPY --from=client /build/out ./out

# Drop root. The relay needs no privileges: it binds a high port, reads a static
# tree and holds websockets in memory.
RUN useradd --create-home --shell /usr/sbin/nologin arena \
    && chown -R arena:arena /app
USER arena

EXPOSE 10000

# Render's health check hits this too, but an image-level check means `docker run`
# locally tells you the same truth the platform will.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,os,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','10000')+'/healthz',timeout=4).status==200 else 1)"

WORKDIR /app/server

# One worker on purpose. The relay keeps room state in process memory, so a
# second worker would serve half the players a different world — and a free
# instance has neither the CPU nor the RAM to pretend otherwise.
CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-10000} --workers 1 --no-access-log --timeout-keep-alive 65"]
