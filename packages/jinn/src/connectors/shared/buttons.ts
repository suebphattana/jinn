/**
 * Shared interactive-button support for connectors (Discord components,
 * Telegram inline keyboards).
 *
 * The model emits a directive in its reply text:
 *
 *   [buttons: Yes | No | Maybe]                 → one row of three buttons
 *   [buttons: Approve | Reject ;; More info]    → two rows ( ;; separates rows )
 *
 * Rows may also be separated by newlines inside the directive. Each connector
 * parses the directive out of the outgoing text, renders platform-native
 * buttons, and — when the user taps one — feeds the chosen label back into the
 * session as a normal incoming message. That reuses the existing message
 * pipeline: no special plumbing in the session manager.
 */

/** Prefix stamped onto every callback id we generate, so we can tell our own
 *  button taps apart from any other interaction payloads. */
export const BUTTON_CALLBACK_PREFIX = "jb:";

/** Discord allows at most 5 buttons per action row and 5 rows per message.
 *  Telegram is more generous but we clamp both to the same sane bounds. */
export const MAX_BUTTONS_PER_ROW = 5;
export const MAX_BUTTON_ROWS = 5;

const DIRECTIVE_RE = /\[buttons:([^\]]*)\]/i;

export type ButtonRow = string[];

export interface ParsedButtons {
  /** Text with the [buttons:…] directive stripped (and trimmed). */
  cleanedText: string;
  /** Parsed rows of button labels, or null when no valid directive present. */
  rows: ButtonRow[] | null;
}

/**
 * Extract a `[buttons:…]` directive from text. Returns the text with the
 * directive removed and the parsed rows (clamped to platform limits). Empty or
 * malformed directives yield `rows: null` but still strip the directive text.
 */
export function parseButtons(text: string): ParsedButtons {
  const match = text.match(DIRECTIVE_RE);
  if (!match) return { cleanedText: text, rows: null };

  const rows: ButtonRow[] = match[1]
    .split(/;;|\r?\n/)
    .map((row) =>
      row
        .split("|")
        .map((label) => label.trim())
        .filter(Boolean)
        .slice(0, MAX_BUTTONS_PER_ROW),
    )
    .filter((row) => row.length > 0)
    .slice(0, MAX_BUTTON_ROWS);

  const cleanedText = text.replace(DIRECTIVE_RE, "").replace(/[ \t]+\n/g, "\n").trim();
  return { cleanedText, rows: rows.length > 0 ? rows : null };
}

/**
 * Bounded label↔id registry. We can't always fit a long label inside a
 * platform callback payload (Telegram caps callback_data at 64 bytes, Discord
 * custom_id at 100 chars), so every button gets a short generated id and we map
 * it back to its label when the tap arrives. Bounded in size and by TTL so a
 * long-running connector can't leak memory.
 */
export class ButtonRegistry {
  private readonly map = new Map<string, { label: string; at: number }>();
  private seq = 0;

  constructor(
    private readonly maxEntries = 5000,
    private readonly ttlMs = 24 * 60 * 60 * 1000,
  ) {}

  /** Register a label and return the full callback payload (prefix + id). */
  register(label: string): string {
    const id = (this.seq++).toString(36);
    this.map.set(id, { label, at: Date.now() });
    this.evict();
    return BUTTON_CALLBACK_PREFIX + id;
  }

  /** Resolve a callback payload back to its label, or null if not ours/expired. */
  resolve(callbackData: string): string | null {
    if (!callbackData.startsWith(BUTTON_CALLBACK_PREFIX)) return null;
    const id = callbackData.slice(BUTTON_CALLBACK_PREFIX.length);
    const entry = this.map.get(id);
    if (!entry) return null;
    if (Date.now() - entry.at > this.ttlMs) {
      this.map.delete(id);
      return null;
    }
    return entry.label;
  }

  /** Number of live entries — exposed for tests/diagnostics. */
  get size(): number {
    return this.map.size;
  }

  private evict(): void {
    // Drop expired entries first, then oldest-inserted until under the cap.
    const now = Date.now();
    for (const [id, entry] of this.map) {
      if (now - entry.at > this.ttlMs) this.map.delete(id);
    }
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

/** The text injected back into the session when a user taps a button. */
export function buttonPressText(label: string): string {
  return label;
}
