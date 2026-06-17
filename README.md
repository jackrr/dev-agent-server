# dev-agent-server

A stateful **MCP Tool Server** that provides dedicated sandboxed environments and git worktrees for engineering agents.

This server integrates with any MCP-compatible client (e.g., Open WebUI) to provide a set of powerful tools for interacting with a target GitHub repository. Each chat session is mapped to a unique `sessionId`, which the server uses to provide an isolated worktree and a dedicated Podman/Docker sandbox container.

---

## What's here

```
src/
  server.ts          # Hono app and MCP SSE transport
  mcp_server.ts     # MCP JSON-RPC handler and tool definitions
  tool_engine.ts     # Core tool logic (bash, file I/O, PRs)
  db.ts              # SQLite schema for session-to-worktree mappings
  workspace.ts       # git clone + per-session worktrees
  sandbox.ts         # per-session container manager (podman-remote or docker CLI)
  github.ts          # gh CLI wrappers (PR creation)
  project_config.ts  # reads + validates <target>/.dev-agent/config.yaml
  api_auth.ts        # API Key authentication middleware
  proxy.ts           # tinyproxy-based egress allowlist management
public/              # (Deleted)
sandbox/             # base sandbox image + seccomp profile (fallback only)
proxy/               # tinyproxy-based egress allowlist proxy
systemd/             # Quadlet units for Fedora + rootless podman (primary deploy path)
Makefile             # convenience targets for the Quadlet/systemd path
test/                # sandbox unit tests
```

---

## Deploy: Fedora + rootless podman + systemd (recommended)

This path uses [Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html)
to express the services as native systemd units.

The runbook below assumes:

- A Fedora host (39+) with rootless podman already installed
- The target repo is `jackrr/musicbox` (substitute your own)

### 1. Host prerequisites

```bash
# Ensure user systemd manager survives logout
sudo loginctl enable-linger $USER

# Enable podman API socket
systemctl --user enable --now podman.socket

# Install required tooling
sudo dnf install -y podman-docker cloudflared make jq
```

### 2. Clone + configure

```bash
cd ~
git clone https://github.com/<you>/dev-agent-server.git
cd dev-agent-server
cp .env.example .env
chmod 600 .env
$EDITOR .env
```

Key `.env` settings:

```
TARGET_REPO=jackrr/musicbox
GITHUB_TOKEN=github_pat_...                          # required for PRs and worktrees
API_KEY=your-secure-api-key                          # Used for server-to-server auth
WORKSPACE_DIR=/data/workspaces
DATA_DIR=/data/db
CONTAINER_SOCKET=/run/user/1000/podman/podman.sock
SANDBOX_USERNS=keep-id:uid=1000,gid=1000
SANDBOX_USER=1000:1000
ENGINE_CLI=podman
SANDBOX_NETWORK=agent-egress
PROXY_URL=http://dev-agent-proxy:8888
```

### 3. Build images

```bash
make build
# Builds:
#   localhost/dev-agent-server:latest
#   localhost/dev-agent-proxy:latest
```

Build the fallback sandbox image:
```bash
podman build -t dev-agent/sandbox-base:latest -f sandbox/Dockerfile.base sandbox/
```

### 4. Install and start

```bash
make install              # symlinks units into ~/.config/containers/systemd/
make up                  # systemctl --user start dev-agent-server.service
make logs                # follow server journal
```

### 5. Connectivity & Auth

By default, the server is bound to `:3000`. If you use a Cloudflare Tunnel, map the public hostname to `http://localhost:3000`.

**Auth**: All `/mcp/*` and `/api/*` endpoints require the `x-api-key` header to match the `API_KEY` in `.env`.

Smoke test:

```bash
# Liveness check
curl -s http://127.0.0.1:3000/healthz                # → ok

# Project info (needs API key)
curl -H "x-api-key: your-secure-api-key" \
     -s http://127.0.0.1:3000/api/project | jq .
```

---

## MCP Interface

The server implements the **Model Context Protocol (MCP)** using SSE transport.

### Endpoints
- `GET /mcp/sse`: Establishes the SSE connection.
- `POST /mcp/messages`: Receives JSON-RPC requests.

### Available Tools
The server exposes the following tools to the MCP Client:

| Tool | Description | Required Params |
|------|-------------|------------------|
| `bash` | Run bash command in session sandbox | `sessionId`, `cmd` |
| `read_file` | Read file from session worktree | `sessionId`, `path` |
| `write_file` | Write file to session worktree | `sessionId`, `path`, `content` |
| `apply_patch` | Apply unified diff to worktree | `sessionId`, `patch` |
| `open_pr` | Commit changes and open GitHub PR | `sessionId`, `title`, `body` |
| `list_recent_sessions` | List existing session IDs | `sessionId`, `limit` |

---

## REST API (Management)

Used for monitoring and cleanup. Requires `x-api-key` header.

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/healthz` | unauthenticated liveness probe |
| GET    | `/api/project` | Get target project configuration |
| GET    | `/api/sessions` | List all active sessions |
| DELETE | `/api/sessions/:id` | Destroy session sandbox and worktree |

---

## Local development

```bash
npm install
TARGET_REPO=owner/repo \
GITHUB_TOKEN=ghp_... \
API_KEY=dev-key \
npm run dev
```

Run tests:
```bash
npm test
```

---

## Target repo contract

The server reads `<target-repo>/.dev-agent/config.yaml` at boot. If missing, it runs in **generic mode** (bash tool only). See `AGENT_CONTRACTS.md` for details.

`<target-repo>/.dev-agent/allowlist.txt` (optional) is synced into the proxy filter.

---

## License

Internal tooling; no license declared.
