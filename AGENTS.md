# AGENTS.md — dev-agent-server

## What this is

A generic, project-agnostic web server that drives a Claude agent against any
GitHub repository that ships a `.dev-agent/` directory. One server instance
drives one target repo; the server itself contains zero project-specific logic.

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
