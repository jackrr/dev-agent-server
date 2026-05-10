# Convenience targets for the Fedora + rootless podman + systemd deploy.
# For the portable docker-compose path, just use `docker compose up -d --build`.

REPO_DIR := $(shell pwd)
QUADLET_DIR := $(HOME)/.config/containers/systemd

.PHONY: help
help:
	@echo "Targets:"
	@echo "  build        Build server + proxy images"
	@echo "  install      Symlink Quadlet units + daemon-reload (auto-start at boot is"
	@echo "               handled by [Install] sections in the .container files)"
	@echo "  reload       Reload user systemd to pick up unit changes"
	@echo "  up           Start dev-agent-server.service (pulls in proxy + network + volumes)"
	@echo "  down         Stop everything"
	@echo "  status       systemctl --user status of all units"
	@echo "  verify       Check that the boot-durability prerequisites are in place"
	@echo "  logs         Follow server journal"
	@echo "  proxy-logs   Follow proxy journal"

.PHONY: build
build:
	podman build -t localhost/dev-agent-server:latest .
	podman build -t localhost/dev-agent-proxy:latest ./proxy

.PHONY: install
install:
	mkdir -p $(QUADLET_DIR)
	# Symlink rather than copy so edits in the repo take effect after `make reload`.
	ln -sf $(REPO_DIR)/systemd/agent-egress.network         $(QUADLET_DIR)/
	ln -sf $(REPO_DIR)/systemd/dev-agent-workspaces.volume  $(QUADLET_DIR)/
	ln -sf $(REPO_DIR)/systemd/dev-agent-db.volume          $(QUADLET_DIR)/
	ln -sf $(REPO_DIR)/systemd/dev-agent-proxy.container    $(QUADLET_DIR)/
	ln -sf $(REPO_DIR)/systemd/dev-agent-server.container   $(QUADLET_DIR)/
	systemctl --user daemon-reload
	@echo
	@echo 'Installed to $(QUADLET_DIR). Run: make up'
	@echo 'Auto-start at boot is handled by [Install] WantedBy=default.target in the'
	@echo '.container files -- no systemctl --user enable needed for Quadlet units.'
	@echo 'Make sure lingering is on (sudo loginctl enable-linger $$USER) so user systemd'
	@echo 'survives logout/reboot.'
	@echo 'Note: units assume the repo is at ~/dev-agent-server. If it is elsewhere,'
	@echo 'edit %h/dev-agent-server paths in the .container files.'

.PHONY: verify
verify:
	@echo "=== lingering enabled for $$USER? ==="
	@loginctl show-user $$USER --property=Linger 2>/dev/null || echo "(no user record)"
	@echo
	@echo "=== podman.socket ==="
	@systemctl --user is-active podman.socket || true
	@ls -l /run/user/$$(id -u)/podman/podman.sock 2>/dev/null || echo "socket not found"
	@echo
	@echo "=== Quadlet unit files present? ==="
	@ls -l $(QUADLET_DIR) 2>/dev/null || echo "$(QUADLET_DIR) does not exist"
	@echo
	@echo "=== service state (is-enabled should be 'generated'; is-active 'active') ==="
	@for u in dev-agent-server.service dev-agent-proxy.service; do \
		printf "%-32s is-enabled=%s is-active=%s\n" "$$u" \
			"$$(systemctl --user is-enabled $$u 2>&1 || true)" \
			"$$(systemctl --user is-active  $$u 2>&1 || true)"; \
	done
	@echo
	@echo "If lingering=yes, podman.socket is active, units are present, and"
	@echo "is-enabled='generated' for both services, the stack will come back on reboot."

.PHONY: reload
reload:
	systemctl --user daemon-reload

.PHONY: up
up:
	systemctl --user start dev-agent-server.service

.PHONY: down
down:
	-systemctl --user stop dev-agent-server.service
	-systemctl --user stop dev-agent-proxy.service

.PHONY: status
status:
	systemctl --user status dev-agent-server.service dev-agent-proxy.service --no-pager || true

.PHONY: logs
logs:
	journalctl --user -u dev-agent-server.service -f

.PHONY: proxy-logs
proxy-logs:
	journalctl --user -u dev-agent-proxy.service -f
