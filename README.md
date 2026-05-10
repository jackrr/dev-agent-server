# dev-agent-server

Generic, project-agnostic web server that drives a Claude agent against any
GitHub repository that ships a `.dev-agent/` directory. One server instance
drives one target repo; the server itself contains zero project-specific logic.

This is **Component 1** in `AGENT_CONTRACTS.md`. Components 2 (bug-report
capture) and 3 (CI / artifact build) live inside the target project's repo.

---

## What's here

```
src/
  server.ts          # Hono app, routes, SSE streaming
  agent.ts           # Claude agent loop + tool dispatch
  db.ts              # SQLite schema + helpers (better-sqlite3)
  workspace.ts       # git clone + per-session worktrees
  sandbox.ts         # per-session container manager (docker CLI → podman/docker)
  github.ts          # gh CLI wrappers (PR creation, release polling)
  poller.ts          # background poll loop for CI-published release artifacts
  project_config.ts  # reads + validates <target>/.dev-agent/config.yaml
  report_parser.ts   # tolerant <bug-report> XML parser
  auth.ts            # Cloudflare Access JWT middleware
public/              # vanilla-JS chat UI
sandbox/             # base sandbox image + seccomp profile (fallback only)
proxy/               # tinyproxy-based egress allowlist proxy
systemd/             # Quadlet units (recommended deploy on Fedora)
docker-compose.yml   # portable fallback for non-systemd hosts
Makefile             # convenience targets for the systemd path
```

---

## Deploy: Fedora + rootless podman + systemd (recommended)

This path uses [Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html)
to express the services as native systemd units. No `docker compose` shim. The
units live in `systemd/` and the `Makefile` automates installation.

The runbook below assumes:

- A Fedora host (39+) with rootless podman already installed
- A Cloudflare-managed domain
- The target repo is `jackrr/musicbox` (substitute your own)

### 1. Host prerequisites

```bash
# So your user systemd manager keeps running when you're not logged in
# (otherwise the service stops the moment your last session ends):
sudo loginctl enable-linger $USER

# Per-user podman API socket. The server container will talk to this to spawn
# per-session sandbox containers.
systemctl --user enable --now podman.socket
ls -l /run/user/$(id -u)/podman/podman.sock     # verify it exists

# Sanity-check the Docker-compatible API:
curl -s --unix-socket /run/user/$(id -u)/podman/podman.sock \
     http://d/v1.41/version | head

# Tooling. podman-docker provides /usr/bin/docker as a thin shim so the
# `docker` CLI inside our container image works against podman's socket.
sudo dnf install -y podman-docker cloudflared make jq

### 2. Clone + configure

```bash
cd ~
git clone https://github.com/<you>/dev-agent-server.git
cd dev-agent-server
cp .env.example .env
chmod 600 .env
$EDITOR .env
```

Fill in `.env` (defaults are already set for rootless podman):

```
ANTHROPIC_API_KEY=sk-ant-...
TARGET_REPO=jackrr/musicbox
GITHUB_TOKEN=github_pat_...                          # contents:rw + PRs:rw on the target repo
WORKSPACE_DIR=/data/workspaces                       # (path inside container; leave as-is)
DATA_DIR=/data/db                                    # (path inside container; leave as-is)
CF_ACCESS_TEAM_DOMAIN=                               # filled in step 5
CF_ACCESS_AUD=                                       # filled in step 5
DEV_AGENT_TRUST_LOCAL=1                              # flip to 0 after step 5
CONTAINER_SOCKET=/run/user/1000/podman/podman.sock   # adjust if your UID isn't 1000
SANDBOX_USERNS=keep-id                               # rootless: maps your UID 1:1 into sandboxes
SANDBOX_USER=1000:1000
SANDBOX_NETWORK=systemd-agent-egress                 # Quadlet prefixes networks with `systemd-`
PROXY_URL=http://dev-agent-proxy:8888
```

`DEV_AGENT_TRUST_LOCAL=1` lets you smoke-test before Cloudflare Access is
wired up. We turn it off in step 6.

### 3. Build images

```bash
make build
# Builds:
#   localhost/dev-agent-server:latest  (the server itself)
#   localhost/dev-agent-proxy:latest   (the egress allowlist proxy)
```

The base sandbox image (`sandbox/Dockerfile.base`) is a *fallback* used only
when the target repo has no `.dev-agent/Dockerfile.sandbox`. Build it once if
you want a reasonable default:

```bash
podman build -t dev-agent/sandbox-base:latest -f sandbox/Dockerfile.base sandbox/
```

For musicbox, the project ships its own `.dev-agent/Dockerfile.sandbox` and
the server builds it on demand the first time a session needs it.

### 4. Install Quadlet units and start the service

```bash
make install              # symlinks systemd/*.{network,volume,container} into
                          #   ~/.config/containers/systemd/ and runs daemon-reload
make up                   # systemctl --user start dev-agent-server.service
make status               # show service status
make logs                 # follow server journal (Ctrl-C to stop)
make verify               # check boot-durability prereqs
```

`dev-agent-server.service` pulls in the proxy, the `agent-egress` network,
and the two volumes via systemd dependencies — there's no need to start them
individually.

**Auto-start on host reboot is already handled** by the `[Install]
WantedBy=default.target` sections in each `.container` file: Quadlet's
generator wires up the necessary symlinks every time `daemon-reload` runs.
You do **not** need `systemctl --user enable` (and in fact it errors on
Quadlet-generated units — they live in a generator path that `enable`
doesn't understand). Just keep lingering on (step 1) and `make verify`
should show `is-enabled=generated` for both services.

Smoke test:

```bash
curl -s http://127.0.0.1:3000/healthz                # → ok
curl -s http://127.0.0.1:3000/api/project | jq .     # → { name, description, ... }

# Confirm the server can reach podman via the bind-mounted socket:
podman exec dev-agent-server docker ps               # lists proxy + server containers

# Confirm the proxy is enforcing the allowlist:
podman exec dev-agent-server \
  curl -x http://dev-agent-proxy:8888 -sS https://example.com \
       -o /dev/null -w '%{http_code}\n'
# → 403 (Forbidden by tinyproxy filter)
podman exec dev-agent-server \
  curl -x http://dev-agent-proxy:8888 -sS https://api.anthropic.com \
       -o /dev/null -w '%{http_code}\n'
# → 200 or auth-related 4xx, but NOT 403
```

If anything's wrong: `make logs`, then `make down`, fix, `make up`.

### 5. Cloudflare Tunnel + Access

In the Cloudflare dashboard → **Zero Trust** → **Networks → Tunnels**:

1. **Create a tunnel** named `dev-agent`. Copy the install command it gives
   you (`cloudflared service install <token>`) and run it on the host. This
   installs cloudflared as a *system* (root) service that connects out from
   the host. It does not need access to the rootless podman socket — it just
   reaches `127.0.0.1:3000`, which the Quadlet unit publishes.
2. Add a **public hostname** to the tunnel:
   - Subdomain: `dev-agent`
   - Domain: `jackratner.com`
   - Service: `HTTP` → `localhost:3000`

Then **Zero Trust → Access → Applications → Add application** (Self-hosted):

3. Name: `dev-agent`. Application domain: `dev-agent.jackratner.com`.
4. Identity provider: GitHub or one-time PIN.
5. Policy: `Include → Emails → your@email`.
6. Once created, click into the application → **Overview** → copy the
   **Application Audience (AUD) Tag** into `.env` as `CF_ACCESS_AUD`.
7. Find your team domain at **Zero Trust → Settings → Custom Pages**
   (`https://<team>.cloudflareaccess.com`). Put `<team>` in `.env` as
   `CF_ACCESS_TEAM_DOMAIN`.

### 6. Lock it down

```bash
sed -i 's/^DEV_AGENT_TRUST_LOCAL=1/DEV_AGENT_TRUST_LOCAL=0/' .env
systemctl --user restart dev-agent-server.service
make verify                                          # confirm boot durability
```

Visit `https://dev-agent.jackratner.com` from your phone or laptop.
Cloudflare Access prompts for email; on success you land on the chat UI and
the server has verified the JWT in `auth.ts`.

### Day-to-day operations

```bash
systemctl --user restart dev-agent-server     # after pulling new code (rebuild first)
make build && systemctl --user restart dev-agent-server

journalctl --user -u dev-agent-server -f       # live logs
journalctl --user -u dev-agent-server -n 200   # recent

podman ps                                      # see proxy + server + active sandboxes
podman volume ls                               # workspaces, db
```

To wipe everything (nuclear):

```bash
make down
podman volume rm systemd-dev-agent-workspaces systemd-dev-agent-db
```

---

## Troubleshooting

**"connection refused" when the server tries to spawn a sandbox.**
The user podman socket isn't running. Check `systemctl --user status
podman.socket`. If lingering wasn't enabled, this happens after every logout.

**Sandbox container can read /workspace but can't write to it.**
`SANDBOX_USERNS` isn't set to `keep-id`, so sandbox UID 1000 is mapped to a
subuid your account can't touch. Verify with `podman exec dev-agent-<id> id`
— the user's UID inside should equal yours on the host.

**`make build` succeeds but `make up` says image not found.**
Quadlet only resolves images from the local podman storage of the user
running the unit. If you built as root (e.g. with `sudo podman build`), the
rootless user can't see them. Build as your user.

**SELinux denials (`avc: denied` in `journalctl`).**
The Quadlet units use `:Z` / `:z` mount labels, which usually suffices. If
you're still seeing denials on the bind-mounted podman socket, add
`SecurityLabelDisable=true` under `[Container]` in
`systemd/dev-agent-server.container`. Acceptable in single-tenant rootless
mode.

**Memory / CPU limits silently ignored.**
cgroups v2 controller delegation isn't enabled for your user slice. Verify:

```bash
cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/cgroup.controllers
# should include "cpu memory pids"
```

If not, `sudo systemctl edit user@.service` and add a delegation drop-in.

**The first sandbox spawn hangs for a minute.**
First-time image pull into your user's container storage. Subsequent runs
are instant.

---

## Deploy: portable docker-compose path

For non-systemd hosts (or if you just prefer compose):

```bash
cp .env.example .env       # edit
docker compose up -d --build
docker compose logs -f server
```

This brings up the same two containers (`server`, `proxy`) on the same two
networks. Functionally equivalent on Linux; less integrated with the host on
Fedora than the Quadlet path.

---

## Target repo contract

The server reads `<target-repo>/.dev-agent/config.yaml` at boot. If it's
missing, the server runs in **generic mode**: bash tool only, no `open_pr`,
no artifact polling. See `AGENT_CONTRACTS.md` for the full schema.

`<target-repo>/.dev-agent/allowlist.txt` (optional) is appended to the proxy
filter. The deploy mounts `./proxy/project.txt` into the proxy container as
the project-specific layer; copy your target's allowlist there:

```bash
cp ../musicbox/.dev-agent/allowlist.txt ./proxy/project.txt
systemctl --user restart dev-agent-proxy.service
```

(Only needed once Component 3 has landed in musicbox.)

---

## REST API

All routes (except `/healthz`) gated by `auth.ts`.

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/healthz` | unauthenticated liveness probe |
| GET    | `/api/project` | `{ name, description, shipEnabled, targetRepo }` |
| POST   | `/api/sessions` | `{ initial_report?, title? }` → new session |
| GET    | `/api/sessions` | list sessions |
| GET    | `/api/sessions/:id` | full session (messages + app_contexts) |
| POST   | `/api/sessions/:id/messages` | SSE stream of agent output |
| GET    | `/api/sessions/:id/pr` | PR + artifact + QR URLs |
| GET    | `/` | static chat UI |

SSE event names: `token`, `tool_call`, `tool_result`, `done`, `error`.

---

## Local development

For poking at the parser, schema, and HTTP surface without the full deploy:

```bash
npm install
DEV_AGENT_TRUST_LOCAL=1 \
TARGET_REPO=owner/repo \
ANTHROPIC_API_KEY=sk-ant-... \
GITHUB_TOKEN=ghp_... \
npm run dev
```

This still requires `git`, `gh`, and a podman/docker socket on the path; the
server clones the target repo on boot and spawns sandbox containers on first
agent tool call.

Run the parser tests on their own (no env required):

```bash
npm test
```

---

## Bug-report `<bug-report>` format

Owned by this component, consumed verbatim. See `AGENT_CONTRACTS.md`. The
parser is intentionally lenient — unknown top-level tags land in `unknown`;
unknown attributes on `<app-context>` (e.g. `truncated="true" size="48213"`)
are preserved as JSON. Multiple `<app-context>` blocks with different `name`
attributes are all stored.

---

## License

Internal tooling; no license declared.
