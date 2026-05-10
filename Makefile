# Convenience targets for the Fedora + rootless podman + systemd deploy.
# For the portable docker-compose path, just use `docker compose up -d --build`.

REPO_DIR := $(shell pwd)
QUADLET_DIR := $(HOME)/.config/containers/systemd

.PHONY: help
help:
	@echo "Targets:"
	@echo "  build        Build server + proxy images"
	@echo "  install      Symlink Quadlet units into ~/.config/containers/systemd/"
	@echo "  reload       Reload user systemd to pick up unit changes"
	@echo "  up           Start dev-agent-server.service (pulls in proxy + network + volumes)"
	@echo "  down         Stop everything"
	@echo "  status       systemctl --user status of all units"
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
	@echo
	@echo "Installed to $(QUADLET_DIR). Run: make reload && make up"
	@echo "Note: units assume the repo is at ~/dev-agent-server. If it's elsewhere,"
	@echo "edit %h/dev-agent-server paths in the .container files."

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
