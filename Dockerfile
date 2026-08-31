FROM node:22-bookworm-slim AS source

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig*.json vite.config.ts ./
COPY compose.yaml ./
COPY src ./src
COPY server ./server
COPY tests ./tests
COPY skills ./skills

FROM source AS test
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/* \
    && npm test

FROM source AS build
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS codex-baked
ARG CODEX_CLI_VERSION=latest
RUN npm install --global --prefix /opt/codex-baked "@openai/codex@${CODEX_CLI_VERSION}" \
    && /opt/codex-baked/bin/codex --version

FROM python:3.12-slim AS codex-relay-baked
ARG CODEX_RELAY_VERSION=0.5.8
ADD https://files.pythonhosted.org/packages/82/e1/74e3a0bbb80984ad7911304c249848c1b873b2161569689b9fa51a9a0363/codex_relay-0.5.8-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl /tmp/codex-relay.whl
RUN printf '%s  %s\n' 'd493b4fc30cbb3fe99f9c3cc367d44a121d43ae5478f2d9791d7bab11b2c8f9f' /tmp/codex-relay.whl | sha256sum -c - \
    && python -m zipfile -e /tmp/codex-relay.whl /tmp/codex-relay \
    && install -D -m 0755 "/tmp/codex-relay/codex_relay-${CODEX_RELAY_VERSION}.data/scripts/codex-relay" /opt/codex-relay/bin/codex-relay \
    && install -D -m 0644 "/tmp/codex-relay/codex_relay-${CODEX_RELAY_VERSION}.dist-info/licenses/LICENSE" /opt/codex-relay/licenses/LICENSE \
    && install -D -m 0644 "/tmp/codex-relay/codex_relay-${CODEX_RELAY_VERSION}.dist-info/sboms/codex-relay.cyclonedx.json" /opt/codex-relay/licenses/codex-relay.cyclonedx.json \
    && /opt/codex-relay/bin/codex-relay --version

FROM node:22-bookworm-slim AS runtime

ARG UV_VERSION=0.11.28
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      acl bash bubblewrap ca-certificates curl ffmpeg fontconfig fonts-liberation fonts-noto-cjk git \
      libreoffice-calc libreoffice-impress libreoffice-writer poppler-utils tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=codex-baked /opt/codex-baked /opt/codex-baked
COPY --from=codex-relay-baked /opt/codex-relay /opt/codex-relay
COPY package.json ./
COPY python-runtime ./python-runtime
COPY scripts ./scripts
COPY skills ./skills

ENV NODE_ENV=production \
    HOME=/home/cww \
    CODEX_HOME=/home/cww/.codex \
    CODEX_RELAY_PATH=/opt/codex-relay/bin/codex-relay \
    PYTHON_RUNTIME_ROOT=/opt/cww-python \
    PYTHON_VERSION=3.12 \
    TZ=Asia/Shanghai

RUN chmod 0755 scripts/*.sh \
    && chmod -R a+rX /app/skills \
    && PYTHON_RUNTIME_ROOT=/opt/cww-python UV_VERSION="$UV_VERSION" ./scripts/setup-python.sh \
    && rm -rf /opt/cww-python/cache \
    && ln -s /app/scripts/codex-runtime.sh /usr/local/bin/codex \
    && groupadd --gid 10001 cww \
    && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash cww \
    && groupadd --gid 11001 cww-owner \
    && useradd --uid 11001 --gid 11001 --home-dir /app/tenants/00000000-0000-4000-8000-000000000001 --no-create-home --shell /usr/sbin/nologin cww-owner \
    && mkdir -p /app/data /app/tenants /home/cww/.codex \
    && chown -R 10001:10001 /app/data /app/tenants /home/cww

USER 0:0
EXPOSE 37821
CMD ["/app/scripts/start-supervisor.sh"]
