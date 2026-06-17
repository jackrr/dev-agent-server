# Agent Contracts

Cross-repo contracts between **dev-agent-server** (this repo) and target
project repos (currently [**musicbox**](https://github.com/jackrr/musicbox)).
Each side's implementation details live in its own repo; this file documents
only the shared interfaces.

---

## 1. `.dev-agent/` directory (target repo → server)

The server clones the target repo, reads `.dev-agent/config.yaml`, and uses
the files alongside it.

```
.dev-agent/
├── config.yaml          # required — identity, sandbox, PR/artifact config
├── allowlist.txt        # optional — egress hostnames appended to the proxy filter
├── Dockerfile.sandbox   # optional — custom sandbox image for this project's toolchain
└── runner/              # self-hosted GitHub Actions runner image (project-owned)
```

### `config.yaml` schema

```yaml
name: "Musicbox"                              # identifying name
description: "Offline-first mobile DAW (Flutter + Rust)"

agent:
  preflight: |                                # optional; bash run once on worktree creation
    cd app && flutter pubget
    cd ../engine && cargo fetch
  context_files:                              # optional; listed for client awareness
    - CLAUDE.md

sandbox:
  build: .dev-agent/Dockerfile.sandbox        # OR image: <pre-built-image>

ship:                                         # optional; enables 'open_pr' tool
  branch_prefix: agent/
  base_branch: main
  artifact_workflow: build-apk.yml
  artifact_asset_pattern: "*-arm64-v8a-*.apk"
  release_tag_pattern: "pr-{pr_number}-{short_sha}"
```

If `config.yaml` is missing, the server runs in **generic mode** (bash tool
only, no `open_pr`).

If `ship:` is present, the server allows the agent to create PR branches as
`<branch_prefix><session-id>` and open Pull Requests via the `open_pr` tool.

---

## 2. MCP Tool Interface

The server provides a set of tools to an MCP client. The client is responsible for 
providing the system prompt and orchestration.

### Core Tools

| Tool | Purpose |
|------|---------|
| `bash` | Executes an arbitrary command in the isolated session container. |
| `read_file` | Reads a file from the session's git worktree. |
| `write_file` | Writes content to a file in the session's git worktree. |
| `apply_patch` | Applies a unified diff to the session's worktree. |
| `open_pr` | Commits pending changes and opens a GitHub PR (if `ship` is configured). |

---

## 3. Server REST API (Management)

Used for infrastructure management. Requires `x-api-key` header.

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/healthz` | liveness probe |
| GET    | `/api/project` | `{ name, description, shipEnabled, targetRepo }` |
| GET    | `/api/sessions` | list active sessions |
| DELETE | `/api/sessions/:id` | destroy session sandbox and worktree |
