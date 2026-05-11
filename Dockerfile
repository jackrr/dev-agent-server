# dev-agent-server image.
# Includes git + gh on the host (used outside the per-session sandboxes for
# clone, worktree, and PR creation).
FROM node:20-bookworm-slim AS build

WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
RUN npx tsc -p .

FROM node:20-bookworm-slim
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl gnupg \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Static docker CLI binary. The server uses it to drive whatever container engine
# is bound at /var/run/docker.sock — works against Docker Engine OR podman's
# Docker-compatible API socket. Used by default (ENGINE_CLI=docker).
ARG DOCKER_CLI_VERSION=27.3.1
RUN set -eux; \
    arch=$(dpkg --print-architecture); \
    case "$arch" in \
      amd64) tarball_arch=x86_64 ;; \
      arm64) tarball_arch=aarch64 ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://download.docker.com/linux/static/stable/${tarball_arch}/docker-${DOCKER_CLI_VERSION}.tgz" \
      | tar -xz -C /usr/local/bin --strip-components=1 docker/docker; \
    docker --version

# Static podman-remote CLI. Needed when ENGINE_CLI=podman — specifically for
# rootless podman deployments that use --userns=keep-id, which the docker CLI
# rejects client-side. Talks to the podman socket bound at /var/run/docker.sock
# (point at it via CONTAINER_HOST=unix:///var/run/docker.sock).
ARG PODMAN_VERSION=5.3.1
RUN set -eux; \
    arch=$(dpkg --print-architecture); \
    case "$arch" in \
      amd64) parch=amd64 ;; \
      arm64) parch=arm64 ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/podman.tar.gz \
      "https://github.com/containers/podman/releases/download/v${PODMAN_VERSION}/podman-remote-static-linux_${parch}.tar.gz"; \
    tar -xzf /tmp/podman.tar.gz -C /tmp; \
    install -m 0755 "/tmp/bin/podman-remote-static-linux_${parch}" /usr/local/bin/podman; \
    rm -rf /tmp/podman.tar.gz /tmp/bin; \
    podman --version

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY public ./public
COPY sandbox ./sandbox

EXPOSE 3000
CMD ["node", "dist/server.js"]
