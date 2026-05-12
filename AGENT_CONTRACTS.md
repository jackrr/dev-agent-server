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
├── prompt.md            # optional — appended verbatim to the agent's system prompt
├── allowlist.txt        # optional — egress hostnames appended to the proxy filter
├── Dockerfile.sandbox   # optional — custom sandbox image for this project's toolchain
└── runner/              # self-hosted GitHub Actions runner image (project-owned)
```

### `config.yaml` schema

```yaml
name: "Musicbox"                              # shown in the web UI
description: "Offline-first mobile DAW (Flutter + Rust)"

agent:
  prompt_file: .dev-agent/prompt.md           # optional; appended to base system prompt
  preflight: |                                # optional; bash run once on worktree creation
    cd app && flutter pub get
    cd ../engine && cargo fetch
  context_files:                              # optional; concatenated into system prompt
    - CLAUDE.md

sandbox:
  build: .dev-agent/Dockerfile.sandbox        # OR image: <pre-built-image>

ship:                                         # optional; omit for chat-only mode
  branch_prefix: agent/
  base_branch: main
  artifact_workflow: build-apk.yml
  artifact_asset_pattern: "*-arm64-v8a-*.apk"
  release_tag_pattern: "pr-{pr_number}-{short_sha}"
```

If `config.yaml` is missing, the server runs in **generic mode** (bash tool
only, no `open_pr`, no artifact polling).

If `ship:` is present, the server creates PR branches as
`<branch_prefix><session-id>`, polls GitHub releases matching
`release_tag_pattern` for asset files matching `artifact_asset_pattern`, and
surfaces download URLs in the chat UI.

---

## 2. `<bug-report>` format (target app → server)

The target app captures a bug report and copies it to the clipboard. The user
pastes it into the server's web UI. The server parses it via
`report_parser.ts`.

```xml
<bug-report version="1">
<description>
Free-form user-typed description.
</description>
<device>
android 14 · pixel 7 · app 0.4.2+17
</device>
<recent-logs lines="120">
[timestamp] log line
...
</recent-logs>
<app-context name="project-digest">
tracks: 6  bpm: 120  steps: 16  ...
</app-context>
<app-context name="project-snapshot" truncated="true" size="48213">
elided
</app-context>
</bug-report>
```

**Required:** `<description>`, `<device>`. Everything else optional.

**Extension point:** `<app-context name="...">` — multiple blocks allowed,
distinguished by `name`. Extra attributes (e.g. `truncated`, `size`) are
preserved as JSON. The server stores each block verbatim and passes them to
the agent; it has no knowledge of what the context names mean.

Unknown top-level tags are stored verbatim. Adding new section types does
not require server changes.

---

## 3. CI artifact flow (target CI → server)

The target repo's CI workflow runs on PRs. For `agent/*` branches it
creates a GitHub pre-release tagged per `ship.release_tag_pattern` with
build artifacts attached.

The server's `ArtifactPoller` finds the release by matching the tag pattern
against the PR number + head SHA, and the artifact by globbing
`ship.artifact_asset_pattern` against release assets.

---

## 4. Server REST API (server → web UI / consumers)

All `/api/*` routes require Cloudflare Access auth. `/healthz` is open.

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/healthz` | liveness probe |
| GET    | `/api/project` | `{ name, description, shipEnabled, targetRepo }` |
| POST   | `/api/sessions` | `{ initial_report?, title? }` → create session |
| GET    | `/api/sessions` | list sessions |
| GET    | `/api/sessions/:id` | session + messages + app_contexts |
| POST   | `/api/sessions/:id/messages` | `{ content }` → SSE stream |
| GET    | `/api/sessions/:id/pr` | PR + artifact + QR URLs |
| GET    | `/` | static chat UI |

**SSE events** on `POST /api/sessions/:id/messages`:

| Event | Data |
|-------|------|
| `token` | `{ text }` |
| `tool_call` | `{ name, input }` |
| `tool_result` | `{ name, output }` |
| `done` | `{ message_id }` |
| `error` | `{ message }` |
