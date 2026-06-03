# AGENTS.md — dev-agent-server

## What this is

A generic, project-agnostic web server that drives an LLM-powered dev agent against any
GitHub repository that ships a `.dev-agent/` directory. One server instance
drives one target repo; the server itself contains zero project-specific logic.

## LLM Provider Support

The server supports multiple LLM providers via the `LLM_PROVIDER` environment variable:

- `anthropic` (default): Uses Anthropic's Claude models via `@anthropic-ai/sdk`
- `openai_compat`: Uses any OpenAI-compatible API server (including self-hosted)

### Configuration Options

**Anthropic (default):**
- `ANTHROPIC_API_KEY`: Required
- `ANTHROPIC_MODEL`: Optional, defaults to `claude-sonnet-4-5`

**OpenAI-Compatible:**
- `OPENAI_COMPAT_API_KEY`: Required
- `OPENAI_COMPAT_BASE_URL`: Required, e.g., `http://localhost:8080/v1`
- `OPENAI_COMPAT_MODEL`: Optional, defaults to `gpt-4o`
- `LLM_PROVIDER`: Set to `openai_compat` to use OpenAI-compatible servers

## Quick reference

```sh
npm install
npm run build          # tsc → dist/
npm run dev            # tsx watch, hot-reload
npm test               # parser + sandbox tests

make build             # podman build server + proxy images
make install           # symlink Quadlet units → ~/.config/containers/systemd/
make up                # systemctl --user start dev-agent-server.service
make down              # stop everything
make logs              # journalctl follow
make verify            # check boot-durability prereqs
```

## Quick reference

```sh
npm install
npm run build          # tsc → dist/
npm run dev            # tsx watch, hot-reload
npm test               # parser + sandbox tests

make build             # podman build server + proxy images
make install           # symlink Quadlet units → ~/.config/containers/systemd/
make up                # systemctl --user start dev-agent-server.service
make down              # stop everything
make logs              # journalctl follow
make verify            # check boot-durability prereqs
```

## Target deployment: Fedora + rootless Podman + Quadlet/systemd

The production deploy path uses Quadlet `.container`/`.network`/`.volume`
unit files in `systemd/`. `docker-compose.yml` exists as a portable fallback
for non-systemd hosts but is **not** the primary path and may lag behind.

Key runtime requirements:
- Fedora 39+ with rootless podman
- `loginctl enable-linger $USER` (so user systemd survives logout)
- `systemctl --user enable --now podman.socket`
- Cloudflare Tunnel + Access for auth

## Contract with target repos

This server reads `<target-repo>/.dev-agent/config.yaml` at boot.
`AGENT_CONTRACTS.md` documents the shared interfaces (config schema,
bug-report format, REST API, artifact flow). The current target is
[musicbox](https://github.com/jackrr/musicbox), which has a matching
`AGENT_CONTRACTS.md`.
