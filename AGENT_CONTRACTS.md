# Agent Contracts — Dev-Agent System

Three components, each in its own repo / working directory:

| # | Component | Repo | Project-aware? |
|---|-----------|------|----------------|
| 1 | **`dev-agent-server`** | standalone (e.g. `~/projects/dev-agent-server/`) | **No** — generic. Drives any repo that ships a `.dev-agent/` directory. |
| 2 | **Bug report capture** (`app/lib/bug_report/`) | inside the musicbox repo | Implements the server's `<bug-report>` spec for this app. |
| 3 | **CI: build & publish APK** | inside the musicbox repo | Musicbox-specific (Flutter + Rust toolchain). |

The split is clean: Component 1 doesn't know the word "musicbox" anywhere. Components 2 and 3 know nothing about the dev-agent server beyond "it expects a `<bug-report>` blob on the clipboard, and it polls GitHub for the artifact this CI publishes."

---

## Shared spec — `<bug-report>` format

**Owned by Component 1** (the server publishes this spec). **Implemented by Component 2** for this particular app. Any future app that wants to talk to a dev-agent-server instance ships its own implementation of the same spec.

```
<bug-report version="1">
<description>
Free-form user-typed description.
</description>
<device>
android 14 · pixel 7 · app 0.4.2+17
</device>
<recent-logs lines="120">
[timestamp] log line
[timestamp] log line
...
</recent-logs>
<app-context name="...">
{Project-specific context. Free-form text or JSON.
 Multiple <app-context> blocks allowed; the `name` attribute distinguishes them.
 Server stores them verbatim and shows them to the agent.}
</app-context>
</bug-report>
```

Required: `<description>`, `<device>`. Everything else is optional. The `version` attribute lets the parser tolerate future additions.

`<app-context>` is the extension point. Musicbox uses two: `name="project-digest"` (human-readable) and `name="project-snapshot"` (full Project JSON, possibly elided with `truncated="true" size="..."`).

The server-side parser extracts each section by tag name and stores them in SQLite for indexing. Unknown tags are stored verbatim under their name. **Adding new section types does not require server changes.**

---

## Shared spec — `.dev-agent/` directory in the target repo

**Owned by Component 1** (the server reads this). **Provided by each project** that wants to be driven by a dev-agent-server.

Layout in the target repo:
```
.dev-agent/
├── config.yaml          # required
├── prompt.md            # optional — appended to the agent's system prompt
└── Dockerfile.sandbox   # optional — custom sandbox image for this project's toolchain
```

`config.yaml` schema:
```yaml
# Identity / display
name: "Musicbox"                              # shown in the web UI
description: "Offline-first mobile DAW"

# Agent setup
agent:
  prompt_file: .dev-agent/prompt.md           # optional; appended to base prompt
  preflight: |                                # optional; bash run on first worktree create
    cd app && flutter pub get
  context_files:                              # optional; concatenated into system prompt
    - CLAUDE.md
    - README.md

# Sandbox image
sandbox:
  image: dev-agent/sandbox-flutter:latest     # pre-built image with toolchain
  # OR:
  # build: .dev-agent/Dockerfile.sandbox      # built once on first session

# PR / artifact integration (server polls GH for these)
ship:
  branch_prefix: agent/                       # all agent PRs go on agent/<session-id>
  base_branch: main
  artifact_workflow: build-apk.yml            # name of the GH Actions workflow
  artifact_asset_pattern: "*-arm64-v8a-*.apk" # glob against release assets
  release_tag_pattern: "pr-{pr_number}-{short_sha}"  # how the CI tags releases
```

The server reads this file at session start. If it's missing, the session falls back to "generic" mode (bash tool only, no PR helpers).

---

## Component 1 — `dev-agent-server`

**Repo:** standalone (suggested name `dev-agent-server`)
**Runtime:** Node 20, TypeScript 5, ESM
**Key deps:** `hono`, `better-sqlite3`, `@anthropic-ai/sdk`, `jose`, `js-yaml`
**Packaging:** Dockerfile + `docker-compose.yml`
**No knowledge of any specific project.** Configured at deploy time with a `TARGET_REPO` env var.

---

### What it does

- Clones a configured `TARGET_REPO` to a workspace; reads `.dev-agent/config.yaml` from the clone.
- Receives a pasted `<bug-report>` through a web chat UI (or REST).
- Creates a session, drives a Claude agent loop with tools that operate inside a per-session git worktree.
- Streams agent output via SSE.
- When the agent calls `open_pr`, creates a GitHub PR on `${branch_prefix}<session-id>`.
- Polls for the CI-published release described in `config.yaml` and surfaces the artifact URL + QR code into the chat.
- Auth: Cloudflare Access JWT verification (skipped in `DEV_AGENT_TRUST_LOCAL=1`).

---

### File layout

```
dev-agent-server/
├── src/
│   ├── server.ts             # Hono app, route registration, static serving
│   ├── auth.ts               # CF Access JWT middleware
│   ├── agent.ts              # Claude agent loop, tool dispatch, SSE streaming
│   ├── db.ts                 # SQLite schema + typed query helpers
│   ├── workspace.ts          # git clone / worktree lifecycle
│   ├── sandbox.ts            # per-session container spawn/exec/destroy
│   ├── github.ts             # gh CLI wrappers, PR creation, release polling
│   ├── project_config.ts     # reads + validates .dev-agent/config.yaml
│   └── report_parser.ts      # extracts <tag> sections from a <bug-report> string
├── public/
│   ├── index.html            # single-page chat UI
│   └── app.js                # vanilla JS; SSE consumer, session list, message input
├── sandbox/
│   ├── Dockerfile.base       # generic minimal sandbox: debian + git + gh + node + bash
│   └── seccomp.json          # docker seccomp profile
├── proxy/
│   ├── Dockerfile            # tinyproxy or small Go CONNECT proxy
│   └── allowlist.txt         # hostnames; see Egress allowlist below
├── Dockerfile                # dev-agent-server image
├── docker-compose.yml        # services: server, proxy; networks: agent_egress, external
├── .env.example
└── README.md                 # rootless Docker, gVisor, CF Access, target repo setup
```

The CI runner image is **not** part of this repo — it is per-project, lives in the target project's repo, and registers itself with GitHub directly. Component 3 owns it.

---

### REST API

All routes (except `GET /healthz`) gated by `auth.ts`.

| Method | Path | Request body | Response |
|--------|------|-------------|----------|
| `POST` | `/sessions` | `{ initial_report?: string, title?: string }` | `{ id, title, created_at }` |
| `GET` | `/sessions` | — | `Session[]` (id, title, created_at, last_message_at, status) |
| `GET` | `/sessions/:id` | — | `{ session, messages, app_contexts }` |
| `POST` | `/sessions/:id/messages` | `{ content: string }` | SSE stream |
| `GET` | `/sessions/:id/pr` | — | `{ pr_number?, pr_url?, artifact_url?, qr_url? }` |
| `GET` | `/project` | — | `{ name, description }` (from `.dev-agent/config.yaml`) |
| `GET` | `/` | — | `public/index.html` |
| `GET` | `/healthz` | — | 200 |

**SSE events** on `POST /sessions/:id/messages`:
```
event: token        data: {"text": "..."}
event: tool_call    data: {"name": "bash", "input": {...}}
event: tool_result  data: {"name": "bash", "output": "..."}
event: done         data: {"message_id": "..."}
event: error        data: {"message": "..."}
```

---

### SQLite schema (`db.ts`)

```sql
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',
  created_at      TEXT NOT NULL,
  last_message_at TEXT,
  description     TEXT,
  device          TEXT,
  worktree_path   TEXT
);

CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role       TEXT NOT NULL,        -- 'user' | 'assistant' | 'tool_result'
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE app_contexts (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  name       TEXT NOT NULL,        -- the `name` attr on <app-context>
  content    TEXT NOT NULL,
  attrs      TEXT,                 -- JSON of all other attrs (truncated, size, etc.)
  PRIMARY KEY (session_id, name)
);

CREATE TABLE pr_links (
  session_id   TEXT PRIMARY KEY REFERENCES sessions(id),
  pr_number    INTEGER,
  pr_url       TEXT,
  artifact_url TEXT,
  qr_url       TEXT,
  updated_at   TEXT NOT NULL
);
```

Note: no `<project-snapshot>` column. Snapshots arrive as `<app-context name="project-snapshot">` and live in `app_contexts`. The server doesn't know they're "project snapshots" — it just stores by name.

---

### Agent tools

Each tool is dispatched via `docker exec` into the per-session container. The agent only ever sees the parameters listed.

```typescript
bash(cmd: string): string
// docker exec <container> bash -lc <cmd>; cwd is /workspace; output truncated to 32 KB

read_file(path: string): string                  // path relative to /workspace; max 100 KB
write_file(path: string, content: string): void  // path relative to /workspace
apply_patch(patch: string): string               // patch -p1 < patch on stdin

open_pr(title: string, body: string): { pr_number, pr_url }
// gh pr create --base ${config.ship.base_branch} --head ${branch_prefix}<sessionId>
// Stores result in pr_links

list_recent_sessions(limit: number): { id, title, description }[]
// Cross-reference similar reports
```

`open_pr` is only registered if `.dev-agent/config.yaml` has a `ship:` block. Otherwise the agent operates in chat-only / patch-suggest mode.

---

### System prompt assembly (`agent.ts`)

Built once per session at creation:

1. **Base prompt** (server-defined, generic):
   > "You are a software engineer. You are working in a git worktree of the project repository. Your task is to understand the user's report and propose or implement a fix. When `open_pr` is available, opening a PR is the only ship mechanism — never push to the base branch directly."

2. For each path in `config.yaml`'s `agent.context_files`, wrap as:
   ```
   <project-context file="CLAUDE.md">
   {file contents}
   </project-context>
   ```

3. Append `agent.prompt_file` content if present (no wrapping — verbatim).

4. Wrap the initial report:
   ```
   <report>
   {raw <bug-report>...</bug-report> blob}
   </report>
   ```

The server is unaware of musicbox-specific concepts (tracks, BPM, etc.). All such knowledge lives in `CLAUDE.md` and the report's `<app-context>` blocks, which the server passes through verbatim.

---

### `report_parser.ts` contract

```typescript
export interface ParsedReport {
  version: string;                       // root tag's version attr
  description?: string;
  device?: string;
  recentLogs?: string;
  appContexts: { name: string; content: string; attrs: Record<string, string> }[];
}

export function parseReport(raw: string): ParsedReport
// Extracts tag content via regex; tolerates whitespace, missing sections, extra tags.
// Multiple <app-context name="..."> blocks each become one entry.
// Unknown attributes are preserved in attrs.
```

---

### `project_config.ts` contract

```typescript
export interface ProjectConfig {
  name: string;
  description?: string;
  agent: {
    promptFile?: string;
    preflight?: string;
    contextFiles: string[];
  };
  sandbox: { image: string } | { build: string };
  ship?: {
    branchPrefix: string;
    baseBranch: string;
    artifactWorkflow: string;
    artifactAssetPattern: string;
    releaseTagPattern: string;
  };
}

// Reads <main-worktree>/.dev-agent/config.yaml. Validates against schema.
// Returns null + logs a warning if file missing → server runs in generic mode
// (no open_pr, no artifact polling).
export function loadProjectConfig(mainWorktree: string): ProjectConfig | null
```

---

### Per-session container spec (`sandbox.ts`)

```
Image:       <config.sandbox.image>     (or built from <config.sandbox.build>)
Runtime:     --runtime=runsc            (gVisor)
Root FS:     --read-only
Tmpfs:       --tmpfs /tmp:rw,size=512m
             --tmpfs /home/agent:rw,size=256m
Bind mount:  $WORKSPACES_VOL/sessions/<id> → /workspace:rw
Network:     --network agent_egress
Env:         HTTP_PROXY=http://proxy:8888  HTTPS_PROXY=http://proxy:8888
             GH_TOKEN=$GITHUB_TOKEN
Caps:        --cap-drop=ALL
Security:    --security-opt no-new-privileges:true
             --security-opt seccomp=sandbox/seccomp.json
Resources:   --cpus 2 --memory 4g --pids-limit 512
User:        --user 1000:1000
```

Created lazily on first `bash` call. After creation, runs `config.agent.preflight` once. Destroyed after `WORKSPACE_TTL_DAYS` idle.

---

### Egress proxy allowlist (`proxy/allowlist.txt`)

Generic + extensible. Server-default list:
```
api.anthropic.com
api.github.com
github.com
*.githubusercontent.com
objects.githubusercontent.com
codeload.github.com
uploads.github.com
registry.npmjs.org
```

**Project-specific additions:** if the target repo contains `.dev-agent/allowlist.txt`, the server appends those entries to the proxy config at startup. Musicbox's file would add `pub.dev`, `dl.google.com`, `maven.google.com`, `repo.maven.apache.org`, `static.crates.io`, `index.crates.io`, etc. This keeps the server's defaults small and generic.

---

### Environment variables (`.env.example`)

```
# Required
ANTHROPIC_API_KEY=sk-ant-...
TARGET_REPO=owner/repo            # e.g. jack/musicbox; the only project this server drives
GITHUB_TOKEN=ghp_...              # contents:write, pull_requests:write
WORKSPACE_DIR=/data/workspaces
DATA_DIR=/data/db
CF_ACCESS_TEAM_DOMAIN=yourteam
CF_ACCESS_AUD=<application audience tag>

# Optional
DEV_AGENT_TRUST_LOCAL=0
WORKSPACE_TTL_DAYS=14
PORT=3000
```

One server instance drives one target repo. To drive multiple projects, run multiple instances (different ports / hostnames). This keeps the auth model and sandbox image management simple.

---

### Web UI (`public/index.html` + `app.js`)

- Header shows `name` + `description` from `GET /project`.
- **Session list** sidebar.
- **New session** view: textarea for pasting `<bug-report>` blob + optional title.
- **Chat view**: streaming SSE; tool calls collapsed in `<details>`; PR/artifact banner appears once `GET /sessions/:id/pr` returns a non-null `artifact_url`.
- Auth: relies on the CF Access cookie set by the browser. No JS auth code.

---

## Component 2 — Bug report capture (musicbox)

**Location:** `app/lib/bug_report/` inside the musicbox repo.
**Standalone agent work directory:** clone of musicbox; agent only touches `app/` (and one tiny addition to `engine/src/lib.rs` for the panic hook).
**Purpose:** captures bugs and emits a `<bug-report>` blob to the clipboard. Implements the spec defined by Component 1. **No networking. No knowledge of dev-agent-server beyond a configurable URL setting that opens in the system browser.**

This module is intentionally generic — the only musicbox-specific bit is what gets fed into the two `<app-context>` blocks. Reusing it in another Flutter app means swapping two providers.

---

### File layout

```
app/lib/bug_report/
├── bug_report_config.dart      # config struct + Riverpod provider
├── log_buffer.dart             # ring buffer + custom debugPrint sink
├── crash_capture.dart          # FlutterError + runZonedGuarded + Rust panic.log reader
├── report_builder.dart         # assembles <bug-report> XML blob
└── ui/
    └── bug_report_sheet.dart   # bottom sheet widget
```

---

### `bug_report_config.dart`

```dart
/// Inject at startup via ProviderScope.overrides.
/// To reuse this module in another app: change appName, appVersion,
/// and supply your own appContexts list.
class AppContext {
  final String name;                       // -> name="..." attr
  final Future<String> Function() build;   // returns the section's content
  final bool defaultEnabled;               // shown as a toggle in the sheet
  final int? sizeLimitBytes;               // emit truncated="true" if exceeded
  const AppContext({
    required this.name,
    required this.build,
    this.defaultEnabled = true,
    this.sizeLimitBytes,
  });
}

class BugReportConfig {
  final String appName;
  final Future<String> Function() appVersion;
  final List<AppContext> appContexts;       // ordered; rendered as <app-context> blocks
  final String? webUrl;                     // "Bug Report Web URL" from settings
  const BugReportConfig({...});
}

final bugReportConfigProvider = Provider<BugReportConfig>((ref) {
  throw UnimplementedError('Override bugReportConfigProvider in ProviderScope');
});
```

**Musicbox wiring in `main.dart`:**
```dart
ProviderScope(
  overrides: [
    bugReportConfigProvider.overrideWithValue(
      BugReportConfig(
        appName: 'Musicbox',
        appVersion: () async => (await PackageInfo.fromPlatform()).version,
        webUrl: prefs.getString('bug_report_web_url'),
        appContexts: [
          AppContext(
            name: 'project-digest',
            build: () async => buildProjectDigest(container.read(projectProvider).value),
          ),
          AppContext(
            name: 'project-snapshot',
            build: () async {
              final p = container.read(projectProvider).value;
              return p == null ? '' : jsonEncode(p.toJson());
            },
            sizeLimitBytes: 32 * 1024,
          ),
        ],
      ),
    ),
  ],
  child: MusicboxApp(),
)
```

`buildProjectDigest()` is a small helper in `app/lib/bug_report/musicbox_digest.dart` (or inlined in `main.dart`) that produces ~10 lines summarizing the current `Project`. This is the only file in this component that references musicbox types — keep it small.

---

### `log_buffer.dart`

```dart
class LogBuffer {
  static final instance = LogBuffer._();
  LogBuffer._();
  static const _capacity = 500;
  final _lines = ListQueue<String>();

  void log(String line) { /* trims, prepends ISO timestamp */ }
  List<String> snapshot() => List.unmodifiable(_lines);
}
```

**`main.dart` integration:**
```dart
debugPrint = (String? message, {int? wrapWidth}) {
  if (message != null) LogBuffer.instance.log(message);
};
```

---

### `crash_capture.dart`

```dart
/// Writes crashes to <appDocDir>/bug_report_pending_crash.txt.
class CrashCapture {
  static Future<void> init() async { ... }
  static void recordError(Object error, StackTrace stack) { ... }
  static Future<String?> consumePendingCrash() async { ... }
}
```

**`main.dart`:**
```dart
void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await CrashCapture.init();   // sets FlutterError.onError + Isolate.current.addErrorListener
  runZonedGuarded(
    () => runApp(const ProviderScope(child: MusicboxApp())),
    CrashCapture.recordError,
  );
}
```

**Rust panic hook** (separate small change to `engine/src/lib.rs` — owned by this component):
```rust
std::panic::set_hook(Box::new(|info| {
    if let Some(dir) = std::env::var_os("APP_DATA_DIR") {
        let _ = std::fs::write(
            std::path::Path::new(&dir).join("panic.log"),
            format!("{info}"),
        );
    }
}));
```

The Flutter side passes `APP_DATA_DIR` into the engine on init (extend `musicbox_engine_init` to take a path, OR the engine reads from `ndk-context` on Android). On next app start, `CrashCapture.init()` reads `<appDocDir>/panic.log`, appends to pending crash file, deletes the panic file.

---

### `report_builder.dart`

```dart
class ReportBuilder {
  static Future<String> build({
    required BugReportConfig config,
    required String description,
    required bool includeLogs,
    required Set<String> enabledContexts,   // names of AppContexts to include
  }) async {
    // 1. Device info: Platform.operatingSystem + version, app version
    // 2. Optional <recent-logs> from LogBuffer
    // 3. For each AppContext whose name ∈ enabledContexts:
    //      content = await ctx.build()
    //      if sizeLimitBytes set and content.length > limit:
    //         emit <app-context name="..." truncated="true" size="N">elided</app-context>
    //      else:
    //         emit <app-context name="...">{content}</app-context>
    // 4. Prepend any pending crash to the logs section.
    // Returns the full <bug-report>...</bug-report> string.
  }
}
```

**Device line** (generic, no app-specific bits):
```
android 14 · pixel 7 · app 0.4.2+17
```

---

### `ui/bug_report_sheet.dart`

Generic UI keyed off `BugReportConfig`. Shown via:
```dart
showModalBottomSheet(
  context: context,
  isScrollControlled: true,
  builder: (_) => const BugReportSheet(),
);
```

Layout:
1. **Description** — multiline `TextField`, required.
2. **Toggles** — one per `AppContext` from config, plus a global "Include logs" toggle. Each toggle for a context with `sizeLimitBytes` shows the actual size next to it, and auto-disables itself if oversize (user can manually re-enable to confirm; they'll see the truncated marker in the preview).
3. **Preview** — `SelectableText`, monospace 11sp, scrolls.
4. **Buttons:**
   - "Copy to clipboard" → `Clipboard.setData`; snackbar `"Copied (N KB). [Open bug report URL →]"`. Link uses `url_launcher` with `config.webUrl`.
   - "Save attachment to file…" → enabled when any context exceeds its size limit; uses `share_plus` to share the oversize content as `<context-name>.txt`.

---

### Changes to existing files

#### `app/lib/main.dart`

- Wrap `runApp` in `runZonedGuarded`; await `CrashCapture.init()` and bindings init.
- Override `debugPrint` to also feed `LogBuffer`.
- Add 🐞 `IconButton` to `AppBar.actions` before the existing export + settings buttons:
  ```dart
  IconButton(
    icon: const Icon(Icons.bug_report_outlined, color: Colors.white54),
    tooltip: 'Bug report',
    onPressed: () => showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => const BugReportSheet(),
    ),
  ),
  ```
- Add `bugReportConfigProvider.overrideWithValue(...)` to `ProviderScope.overrides`.

#### `app/lib/ui/settings/settings_page.dart`

After the "PROJECT" section, add:

```dart
const _SectionHeader('BUG REPORT'),
const SizedBox(height: 8),
const Text(
  'URL opened from the snackbar after copying a bug report. '
  'Optional — paste a URL only if you have a place to send reports.',
  style: TextStyle(fontSize: 12, color: Colors.white38, height: 1.5),
),
const SizedBox(height: 12),
TextField(
  controller: _bugReportUrlCtrl,
  decoration: const InputDecoration(hintText: 'https://...'),
  onSubmitted: (v) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('bug_report_web_url', v.trim());
  },
),
```

Stored under key `'bug_report_web_url'` in `SharedPreferences`. No `flutter_secure_storage` — this is not a secret.

---

### New `pubspec.yaml` deps

```yaml
package_info_plus: ^8.1.3
shared_preferences: ^2.3.3
url_launcher: ^6.3.1
```

---

## Component 3 — CI: build & publish APK

**Location inside musicbox repo:** `.github/workflows/build-apk.yml` + `.dev-agent/runner/Dockerfile`
**Standalone agent work directory:** clone of musicbox.
**Purpose:** builds signed release APKs, publishes pre-release with QR for `agent/*` branches. The dev-agent-server polls these releases via the `ship.artifact_*` config.

The `.dev-agent/` directory is the integration point with Component 1 — see the next subsection.

---

### `.dev-agent/config.yaml` (in musicbox repo)

```yaml
name: "Musicbox"
description: "Offline-first mobile DAW (Flutter + Rust)"

agent:
  prompt_file: .dev-agent/prompt.md
  preflight: |
    cd app && flutter pub get
    cd ../engine && cargo fetch
  context_files:
    - CLAUDE.md

sandbox:
  build: .dev-agent/Dockerfile.sandbox

ship:
  branch_prefix: agent/
  base_branch: main
  artifact_workflow: build-apk.yml
  artifact_asset_pattern: "*-arm64-v8a-*.apk"
  release_tag_pattern: "pr-{pr_number}-{short_sha}"
```

### `.dev-agent/allowlist.txt` (in musicbox repo)

Project-specific egress hosts (see Component 1's allowlist section):
```
pub.dev
storage.googleapis.com
dl.google.com
maven.google.com
repo.maven.apache.org
static.crates.io
index.crates.io
```

### `.dev-agent/prompt.md` (in musicbox repo)

A short addendum, e.g.:
```
This project builds for Android (primary) and iOS. Audio is generated by
a Rust cdylib in engine/; UI is Flutter in app/. After any Rust change you
must rebuild the native lib via scripts/build_android.sh — hot reload will
not pick up Rust changes.
```

### `.dev-agent/Dockerfile.sandbox` (in musicbox repo)

The toolchain image used by per-session agent containers. Contains: Debian + git + gh + node + rustup with Android targets + cargo-ndk + Android cmdline-tools/SDK/NDK + Flutter. (See the previous version of this doc for the full Dockerfile recipe — it lives here unchanged, just relocated from the server repo to the musicbox repo.)

### `.dev-agent/runner/Dockerfile` (in musicbox repo)

Same toolchain as `Dockerfile.sandbox` plus the GitHub Actions runner agent (`myoung34/github-runner` base or equivalent). Used to register a self-hosted runner with label `musicbox-builder` against the musicbox repo.

The runner is **not part of the dev-agent-server's docker-compose** — it's run separately (by you, on the same host or elsewhere). The dev-agent-server doesn't know it exists; it only knows to poll the GitHub release the runner produces.

---

### `.github/workflows/build-apk.yml`

```yaml
name: Build APK

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  build:
    runs-on: [self-hosted, linux, musicbox-builder]
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }

      # Toolchains pre-installed in runner image — no setup steps needed.

      - name: Build native libs
        run: ./scripts/build_android.sh

      - name: Write signing config
        run: |
          echo "${{ secrets.ANDROID_KEYSTORE_BASE64 }}" | base64 -d > release.keystore
          cat > app/android/key.properties <<EOF
          storePassword=${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          keyPassword=${{ secrets.ANDROID_KEY_PASSWORD }}
          keyAlias=${{ secrets.ANDROID_KEY_ALIAS }}
          storeFile=../../../../release.keystore
          EOF

      - name: Flutter pub get
        working-directory: app
        run: flutter pub get

      - name: Build APK
        working-directory: app
        run: flutter build apk --release --split-per-abi

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: apk-${{ github.sha }}
          path: app/build/app/outputs/flutter-apk/app-arm64-v8a-release.apk
          retention-days: 30

      - name: Detect agent branch
        id: detect
        run: |
          if [[ "${{ github.head_ref }}" == agent/* ]]; then
            echo "is_agent=true" >> $GITHUB_OUTPUT
            echo "short_sha=$(git rev-parse --short HEAD)" >> $GITHUB_OUTPUT
          else
            echo "is_agent=false" >> $GITHUB_OUTPUT
          fi

      - name: Create release
        if: steps.detect.outputs.is_agent == 'true'
        id: release
        env: { GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}" }
        run: |
          # Tag MUST match .dev-agent/config.yaml's release_tag_pattern
          TAG="pr-${{ github.event.number }}-${{ steps.detect.outputs.short_sha }}"
          gh release create "$TAG" \
            app/build/app/outputs/flutter-apk/app-arm64-v8a-release.apk \
            --prerelease \
            --title "Agent PR #${{ github.event.number }} (${{ steps.detect.outputs.short_sha }})" \
            --notes "Auto-built from ${{ github.head_ref }}"
          echo "tag=$TAG" >> $GITHUB_OUTPUT
          echo "apk_url=$(gh release view "$TAG" --json assets -q '.assets[0].browserDownloadUrl')" >> $GITHUB_OUTPUT

      - name: QR code
        if: steps.detect.outputs.is_agent == 'true'
        run: |
          node -e "require('qrcode').toFile('/tmp/qr.png', '${{ steps.release.outputs.apk_url }}', { width: 300 })"

      - name: Upload QR
        if: steps.detect.outputs.is_agent == 'true'
        id: qr
        env: { GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}" }
        run: |
          gh release upload "${{ steps.release.outputs.tag }}" /tmp/qr.png
          echo "qr_url=$(gh release view "${{ steps.release.outputs.tag }}" --json assets -q '.assets[]|select(.name=="qr.png")|.browserDownloadUrl')" >> $GITHUB_OUTPUT

      - name: PR comment
        if: steps.detect.outputs.is_agent == 'true'
        env: { GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}" }
        run: |
          gh pr comment ${{ github.event.number }} --body "
          ### 📦 APK Ready
          **Download:** ${{ steps.release.outputs.apk_url }}
          <img src='${{ steps.qr.outputs.qr_url }}' width='200'/>
          Built from \`${{ github.head_ref }}\` @ \`${{ steps.detect.outputs.short_sha }}\`
          "
```

The release tag `pr-{pr_number}-{short_sha}` matches `release_tag_pattern` in `.dev-agent/config.yaml`. The dev-agent-server uses that pattern to find the release for a given PR; the asset glob `*-arm64-v8a-*.apk` picks out the APK from the release assets.

---

### Required GitHub repo secrets

| Secret | Value |
|--------|-------|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 release.keystore` |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | key alias |
| `ANDROID_KEY_PASSWORD` | key password |
| `RUNNER_TOKEN` | from GitHub → Settings → Actions → Runners → Add new runner |

---

## Integration checklist

1. Spin up Component 1 (`dev-agent-server`) standalone. Verify with a stub repo that has only a minimal `.dev-agent/config.yaml` — confirm the server reads it, refuses generic-mode operation if required, and bug-report parsing round-trips.
2. Land Component 2 in musicbox: bug-report sheet works end-to-end, copies a well-formed `<bug-report>` to clipboard, pastes cleanly into the dev-agent-server's web UI.
3. Land Component 3 in musicbox: `.dev-agent/config.yaml`, sandbox + runner Dockerfiles, `build-apk.yml`. Register runner with the repo. Confirm a hand-pushed `agent/test` branch produces a release + QR comment.
4. Wire it together: point `dev-agent-server`'s `TARGET_REPO` at musicbox; run a "say hello in README" task end-to-end; APK URL appears in chat.
