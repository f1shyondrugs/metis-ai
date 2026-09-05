FROM node:22-bookworm

WORKDIR /app
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NODE_ENV=production
ENV METIS_DOCKER=1
ENV AGENT_CWD=/workspace
ENV CHAT_DATA_DIR=/data
ENV AI_CHAT_ROOT=/app
ARG METIS_RELEASE_TAG
ARG METIS_RELEASE_VERSION
ARG METIS_RELEASE_COMMIT
ENV METIS_RELEASE_TAG=$METIS_RELEASE_TAG
ENV METIS_RELEASE_VERSION=$METIS_RELEASE_VERSION
ENV METIS_RELEASE_COMMIT=$METIS_RELEASE_COMMIT
LABEL org.opencontainers.image.version=$METIS_RELEASE_VERSION \
      org.opencontainers.image.revision=$METIS_RELEASE_COMMIT

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

COPY package.json pnpm-lock.yaml ./
COPY requirements-antigravity.txt ./
RUN pnpm install --frozen-lockfile
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && python3 -m pip install --no-cache-dir --break-system-packages -r requirements-antigravity.txt \
  && rm -rf /var/lib/apt/lists/*

COPY . .
RUN pnpm build
RUN pnpm exec playwright install --with-deps chromium

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3100 8787
ENTRYPOINT ["/entrypoint.sh"]
CMD ["pnpm", "exec", "tsx", "server.mjs"]
