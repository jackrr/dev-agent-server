import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export type LLMStreamOpts = {
  system: string;
  messages: Anthropic.Messages.MessageParam[];
  tools: Anthropic.Messages.Tool[];
  maxTokens: number;
  onToken: (text: string) => void;
  signal?: AbortSignal;
};

export type LLMResponse = {
  content: Anthropic.Messages.ContentBlock[];
  stop_reason: string;
};

export interface LLMProvider {
  stream(opts: LLMStreamOpts): Promise<LLMResponse>;
}

// ---------- Anthropic ----------

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;

  constructor() {
    // SDK reads ANTHROPIC_API_KEY from env automatically.
    this.client = new Anthropic();
  }

  async stream(opts: LLMStreamOpts): Promise<LLMResponse> {
    const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
    const s = this.client.messages.stream({
      model,
      max_tokens: opts.maxTokens,
      system: opts.system,
      tools: opts.tools,
      messages: opts.messages,
    });

    s.on("text", opts.onToken);

    const onAbort = () => s.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const final = await s.finalMessage();
      return { content: final.content, stop_reason: final.stop_reason ?? "end_turn" };
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
}

// ---------- OpenAI-compat (Ollama, etc.) ----------

type OAIMessage = OpenAI.ChatCompletionMessageParam;

/** Convert Anthropic-format message history to OpenAI chat messages. */
function toOAIMessages(
  system: string,
  messages: Anthropic.Messages.MessageParam[],
): OAIMessage[] {
  const result: OAIMessage[] = [{ role: "system", content: system }];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
      } else {
        // Tool-result blocks — each becomes a separate "tool" message.
        for (const block of msg.content as Anthropic.Messages.ToolResultBlockParam[]) {
          const content =
            typeof block.content === "string"
              ? block.content
              : ((block.content ?? []) as Anthropic.Messages.TextBlockParam[])
                  .filter((b) => b.type === "text")
                  .map((b) => b.text)
                  .join("");
          result.push({ role: "tool", tool_call_id: block.tool_use_id, content });
        }
      }
    } else if (msg.role === "assistant") {
      const blocks = Array.isArray(msg.content)
        ? (msg.content as Anthropic.Messages.ContentBlock[])
        : [];
      const textContent =
        blocks
          .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("") || null;
      const toolUses = blocks.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
      );

      if (toolUses.length > 0) {
        result.push({
          role: "assistant",
          content: textContent,
          tool_calls: toolUses.map((b) => ({
            id: b.id,
            type: "function" as const,
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          })),
        });
      } else {
        result.push({ role: "assistant", content: textContent ?? "" });
      }
    }
  }

  return result;
}

/** Convert Anthropic tool schemas to OpenAI function-tool format. */
function toOAITools(tools: Anthropic.Messages.Tool[]): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}

export class OpenAICompatProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;

  constructor(config: { baseURL: string; apiKey: string; model: string }) {
    this.client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });
    this.model = config.model;
  }

  async stream(opts: LLMStreamOpts): Promise<LLMResponse> {
    const messages = toOAIMessages(opts.system, opts.messages);
    const tools = toOAITools(opts.tools);

    const s = await this.client.chat.completions.create(
      {
        model: this.model,
        max_tokens: opts.maxTokens,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
        stream: true,
      },
      { signal: opts.signal },
    );

    let textContent = "";
    // Accumulate streamed tool-call fragments by index.
    const toolAccum = new Map<number, { id: string; name: string; arguments: string }>();
    let stopReason = "end_turn";

    for await (const chunk of s) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        textContent += delta.content;
        opts.onToken(delta.content);
      }

      for (const tc of delta.tool_calls ?? []) {
        if (!toolAccum.has(tc.index)) {
          toolAccum.set(tc.index, { id: "", name: "", arguments: "" });
        }
        const acc = toolAccum.get(tc.index)!;
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.arguments += tc.function.arguments;
      }

      const finish = chunk.choices[0]?.finish_reason;
      if (finish === "tool_calls") stopReason = "tool_use";
      else if (finish === "stop") stopReason = "end_turn";
    }

    // Rebuild Anthropic-format content blocks for storage and tool dispatch.
    const content: Anthropic.Messages.ContentBlock[] = [];
    if (textContent) content.push({ type: "text", text: textContent });
    for (const [, tc] of toolAccum) {
      let input: unknown = {};
      try {
        input = JSON.parse(tc.arguments);
      } catch {}
      content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
    }

    return { content, stop_reason: stopReason };
  }
}

// ---------- factory ----------

export function buildProvider(): LLMProvider {
  const providerType = process.env.LLM_PROVIDER ?? "anthropic";

  if (providerType === "openai_compat") {
    const baseURL = process.env.OPENAI_COMPAT_BASE_URL;
    const apiKey = process.env.OPENAI_COMPAT_API_KEY;
    const model = process.env.OPENAI_COMPAT_MODEL;
    if (!baseURL || !apiKey || !model) {
      throw new Error(
        "LLM_PROVIDER=openai_compat requires OPENAI_COMPAT_BASE_URL, OPENAI_COMPAT_API_KEY, and OPENAI_COMPAT_MODEL",
      );
    }
    console.log(`[llm] provider=openai_compat baseURL=${baseURL} model=${model}`);
    return new OpenAICompatProvider({ baseURL, apiKey, model });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("missing required env var: ANTHROPIC_API_KEY");
  }
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
  console.log(`[llm] provider=anthropic model=${model}`);
  return new AnthropicProvider();
}
