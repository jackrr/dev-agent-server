import { Context } from "hono";
import { ToolEngine } from "./tool_engine.js";

export class MCPServer {
  constructor(private toolEngine: ToolEngine) {}

  /**
   * Handles the SSE connection.
   * Sends the 'endpoint' event and keeps the connection open.
   */
  handleSSE(ctx: Context) {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        // Send the endpoint event as per MCP spec.
        // We'll use '/messages' as the POST endpoint.
        const endpointEvent = `event: endpoint\ndata: /messages\n\n`;
        controller.enqueue(encoder.encode(endpointEvent));
      },
    });

    return ctx.body(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }

  /**
   * Handles JSON-RPC requests from the client.
   */
  async handleMessage(ctx: Context) {
    const body = await ctx.req.json();
    const { method, params, id } = body;

    console.log(`MCP Request: ${method}`, params);

    try {
      switch (method) {
        case "initialize":
          return ctx.json({
          	jsonrpc: "2.0",
          	id,
          	result: {
          	  protocolVersion: "2024-11-05",
          	  capabilities: {
          	    tools: {},
          	  },
          	  serverInfo: {
          	    name: "dev-agent-server",
          	    version: "0.1.0",
          	  },
          	},
          	});

        case "tools/list":
          return ctx.json({
          	jsonrpc: "2.0",
          	id,
          	result: {
          	  tools: [
          	    {
          	      name: "bash",
          	      description: "Run a bash command inside the per-session sandbox container. cwd is /workspace. Output is truncated to 32 KB.",
          	      inputSchema: {
          	        type: "object",
          	        properties: { sessionId: { type: "string" }, cmd: { type: "string" } },
          	        required: ["sessionId", "cmd"],
          	      },
          	    },
          	    {
          	      name: "read_file",
          	      description: "Read a file from the workspace. Path is relative to /workspace. Max 100 KB.",
          	      inputSchema: {
          	        type: "object",
          	        properties: { sessionId: { type: "string" }, path: { type: "string" } },
          	        required: ["sessionId", "path"],
          	      },
          	    },
          	    {
          	      name: "write_file",
          	      description: "Write a file to the workspace. Path is relative to /workspace.",
          	      inputSchema: {
          	        type: "object",
          	        properties: { sessionId: { type: "string" }, path: { type: "string" }, content: { type: "string" } },
          	        required: ["sessionId", "path", "content"],
          	      },
          	    },
          	    {
          	      name: "apply_patch",
          	      description: "Apply a unified diff (-p1) on top of /workspace via the `patch` command.",
          	      inputSchema: {
          	        type: "object",
          	        properties: { sessionId: { type: "string" }, patch: { type: "string" } },
          	        required: ["sessionId", "patch"],
          	      },
          	    },
          	    {
          	      name: "list_recent_sessions",
          	      description: "List recent sessions on this server with their titles and short descriptions.",
          	      inputSchema: {
          	        type: "object",
          	        properties: { sessionId: { type: "string" }, limit: { type: "number" } },
          	        required: ["sessionId", "limit"],
          	      },
          	    },
          	    {
          	      name: "open_pr",
          	      description: "Commit any pending changes in the worktree, push the session branch, and open a GitHub pull request.",
          	      inputSchema: {
          	        type: "object",
          	        properties: { sessionId: { type: "string" }, title: { type: "string" }, body: { type: "string" } },
          	        required: ["sessionId", "title", "body"],
          	      },
          	    },
          	  ],
          	},
          	});

        case "tools/call": {
          const { name, arguments: args, cursor } = params as any;
          // The sessionId should be passed via arguments or stored in some way.
          // For now, we'll expect it in the arguments or a header.
          // But the plan says: "Map Open WebUI's chat_id / sessionId to dedicated git worktrees".
          // We'll assume sessionId is part of the arguments or passed via a custom header.
          // Let's check for a 'sessionId' in args.
          const sessionId = args.sessionId;
          if (!sessionId) {
            return ctx.json({
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: "sessionId is required in tool arguments" },
            });
          }

          const result = await this.toolEngine.executeTool(sessionId, name, args, ctx.req.raw.signal);
          return ctx.json({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: result }],
            },
          });
        }

        default:
          return ctx.json({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          });
      }
    } catch (e) {
      return ctx.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: (e as Error).message },
      });
    }
  }
}
