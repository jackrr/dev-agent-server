/**
 * Parses the shared `<bug-report>` format defined in AGENT_CONTRACTS.md.
 *
 * Tolerant by design: missing sections, unknown attrs, unknown tags, and
 * surrounding whitespace are all OK. The format is generic — this module
 * has no app-specific knowledge.
 */

export interface AppContextSection {
  name: string;
  content: string;
  attrs: Record<string, string>;
}

export interface ParsedReport {
  version: string;
  description?: string;
  device?: string;
  recentLogs?: string;
  /** All <app-context name="..."> blocks in document order. */
  appContexts: AppContextSection[];
  /**
   * Any other top-level child tags inside <bug-report> that we don't recognise.
   * Stored verbatim under their tag name so future additions don't require server changes.
   */
  unknown: { tag: string; content: string; attrs: Record<string, string> }[];
}

/** Parses an XML-ish attribute list, e.g. `version="1" truncated="true"`. */
function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  // name="value" | name='value' | name=value (no quotes)
  const re = /([A-Za-z_][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const key = m[1]!;
    const val = m[2] ?? m[3] ?? m[4] ?? "";
    out[key] = val;
  }
  return out;
}

/** Strips one leading and one trailing newline (but not all whitespace). */
function trimSurroundingNewline(s: string): string {
  return s.replace(/^\r?\n/, "").replace(/\r?\n[ \t]*$/, "");
}

interface ChildTag {
  tag: string;
  attrs: Record<string, string>;
  content: string;
}

/** Iterates all immediate child tags of the given content string. */
function* iterChildren(body: string): Generator<ChildTag> {
  // Match an opening tag, then find its matching closing tag, naively (no nested tags
  // of the same name expected at this layer — the format is flat).
  const openRe = /<([A-Za-z][\w-]*)([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(body)) !== null) {
    const tag = m[1]!;
    const attrsRaw = m[2] ?? "";
    // Self-closing? <foo .../>
    if (attrsRaw.endsWith("/")) {
      yield { tag, attrs: parseAttrs(attrsRaw.slice(0, -1)), content: "" };
      continue;
    }
    const closeTag = `</${tag}>`;
    const start = openRe.lastIndex;
    const end = body.indexOf(closeTag, start);
    if (end < 0) {
      // Unterminated; skip.
      continue;
    }
    const inner = body.slice(start, end);
    yield { tag, attrs: parseAttrs(attrsRaw), content: trimSurroundingNewline(inner) };
    openRe.lastIndex = end + closeTag.length;
  }
}

export function parseReport(raw: string): ParsedReport {
  const rootMatch = raw.match(/<bug-report\b([^>]*)>([\s\S]*?)<\/bug-report>/);
  const result: ParsedReport = {
    version: "1",
    appContexts: [],
    unknown: [],
  };
  if (!rootMatch) {
    return result;
  }
  const rootAttrs = parseAttrs(rootMatch[1] ?? "");
  if (rootAttrs.version) result.version = rootAttrs.version;
  const body = rootMatch[2] ?? "";

  for (const child of iterChildren(body)) {
    switch (child.tag) {
      case "description":
        result.description = child.content;
        break;
      case "device":
        result.device = child.content;
        break;
      case "recent-logs":
        result.recentLogs = child.content;
        break;
      case "app-context": {
        const name = child.attrs.name ?? "";
        if (!name) break;
        const { name: _ignored, ...rest } = child.attrs;
        result.appContexts.push({ name, content: child.content, attrs: rest });
        break;
      }
      default:
        result.unknown.push({ tag: child.tag, content: child.content, attrs: child.attrs });
    }
  }
  return result;
}
