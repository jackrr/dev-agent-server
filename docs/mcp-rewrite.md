# Plan: Transforming `dev-agent-server` into a Stateful MCP Tool Server

## Goal
Transition the server from a standalone agent host with its own UI to a professional Tool Server using the **Model Context Protocol (MCP)**. This will allow it to integrate directly with Open WebUI (and other MCP clients), providing dedicated worktrees and sandboxes per chat session.

## Architecture Shift
- **Orchestration $\rightarrow$ Execution**: Remove the internal LLM loop and agent orchestration. Open WebUI (the MCP Host) now decides which tools to call.
- **State Management**: Map Open WebUI's `chat_id` / `sessionId` to dedicated git worktrees and Podman sandboxes.
- **Interface**: Replace the Hono REST API for chat with an MCP SSE (Server-Sent Events) transport.

## Implementation Steps

### 1. Core Logic Decoupling (The "Tool Engine")
- **Create `src/tool_engine.ts`**:
    - Extract the tool implementation from `src/agent.ts` into a `ToolEngine` class.
    - Tools to implement: `bash`, `read_file`, `write_file`, `apply_patch`, `open_pr`.
    - **Stateful Execution**: Every tool call must accept a `sessionId`.
    - **Just-in-Time Provisioning**: If a tool is called for a new `sessionId`, the `ToolEngine` should automatically trigger `Workspace` and `SandboxManager` to create the required worktree and container before executing.

### 2. MCP Server Integration
- **Dependency**: Install `@modelcontextprotocol/sdk`.
- **Transport**: Implement the MCP SSE transport using Hono.
- **Tool Definition**: 
    - Define the tools in the MCP spec (name, description, input schema).
    - Ensure the `sessionId` is captured from the request context or passed as a parameter to maintain session isolation.
- **Discovery**: Implement the MCP `listTools` handler so the client can automatically discover available capabilities.

### 3. Database & State Simplification
- **`src/db.ts` Refactor**:
    - **Remove**: `messages` and `app_contexts` tables (history is now managed by the MCP client).
    - **Keep**: `sessions` (for `sessionId` $\rightarrow$ `worktree_path` mapping) and `pr_links`.
- **Cleanup**: Remove any logic that specifically seeds conversations or handles "bug reports" inside the server.

### 4. Redundant Component Removal
- **LLM Layer**: Delete `src/llm_provider.ts` and the agent loop in `src/agent.ts`.
- **Frontend**: Delete the `public/` directory and all routes serving the chat UI.
- **Authentication**: 
    - Replace browser-based Cloudflare Access JWT middleware in `src/auth.ts` with a simpler API Key / Bearer Token system for server-to-server communication.

### 5. Infrastructure & Deployment
- **Dockerfile**: Update to remove unnecessary build steps or dependencies.
- **systemd/Quadlets**: Update environment variables and service descriptions to reflect the "Tool Server" status.
- **Makefile**: Update targets if necessary.

## Summary of Changes

| Feature | Current State | Target State (MCP) |
| :--- | :--- | :--- |
| **Orchestration** | Internal (Claude API $\rightarrow$ Loop $\rightarrow$ Tool) | External (Open WebUI $\rightarrow$ MCP $\rightarrow$ Tool) |
| **Interface** | Custom Web UI + Custom REST API | MCP SSE Transport |
| **State** | Stores full chat history in SQLite | Stores only worktree/sandbox mappings |
| **Tooling** | Hardcoded in `Agent` class | Exposed via MCP Tool Discovery |
| **Isolation** | Session-based worktrees | Session-based worktrees (mapped via `chat_id`) |
| **Auth** | Cloudflare Access (Browser) | API Key (Server $\rightarrow$ Server) |
