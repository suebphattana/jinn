/**
 * Strip Markdown syntax from text, leaving plain readable prose.
 *
 * Used in two places that must NOT show (or speak) raw markdown:
 *   - the Jinn Talk transcript caption (mirrors spoken audio), and
 *   - `cleanPreview` (session preview labels), which layers @mention/#NNN
 *     stripping + capitalization on top.
 *
 * Newlines are PRESERVED (only horizontal whitespace is collapsed) so callers
 * that split on sentence/line boundaries — e.g. `splitSentences` driving the
 * per-sentence caption — keep their breaks. Callers that want a single line
 * (like `cleanPreview`) collapse newlines themselves afterwards.
 *
 * Intentionally regex-only (no markdown parser dependency): the goal is to drop
 * syntax characters, not to build an AST.
 */
export function stripMarkdown(raw: string): string {
  let text = raw
  // Headings: leading #'s followed by whitespace.
  text = text.replace(/^#{1,6}\s+/gm, "")
  // Bold/italic markers (*, **, ***, _, __, ___).
  text = text.replace(/\*{1,3}|_{1,3}/g, "")
  // List markers (-, *, •, numbered) at line start.
  text = text.replace(/^[ \t]*[-*•]\s+/gm, "")
  text = text.replace(/^[ \t]*\d+[.)]\s+/gm, "")
  // Blockquotes.
  text = text.replace(/^>\s*/gm, "")
  // Code fence lines (incl. a language tag) — BEFORE the inline-backtick strip,
  // so the ``` delimiter and its `ts`/`js` tag are dropped as a unit.
  text = text.replace(/^[ \t]*```\w*[ \t]*$/gm, "")
  // Inline code backticks.
  text = text.replace(/`+/g, "")
  // Link syntax [text](url) → text.
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
  // Collapse horizontal whitespace only (keep newlines for sentence splitting),
  // trim whitespace around newlines, and cap blank-line runs.
  text = text.replace(/[^\S\n]+/g, " ")
  text = text.replace(/[^\S\n]*\n[^\S\n]*/g, "\n")
  text = text.replace(/\n{3,}/g, "\n\n")
  return text.trim()
}
