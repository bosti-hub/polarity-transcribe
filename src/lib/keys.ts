// Configurable keys (for example the pedals of a transcription foot switch, which send key
// presses). A key is stored as "Ctrl+Alt+Shift+Code", where Code is KeyboardEvent.code, so it
// does not depend on the keyboard layout.

export function keyCombo(e: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "code" | "key">): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.metaKey) parts.push("Meta");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(e.code || e.key);
  return parts.join("+");
}

const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;

/** True while only a modifier is held: wait for the real key. */
export function isModifierOnly(e: Pick<KeyboardEvent, "code" | "key">): boolean {
  return MODIFIER_CODES.test(e.code) || ["Control", "Shift", "Alt", "Meta"].includes(e.key);
}

/** Keys needed for typing (letters, digits, space, punctuation, Enter…) cannot be used without Ctrl/Alt. */
export function isTypingKey(combo: string): boolean {
  const parts = combo.split("+");
  const code = parts[parts.length - 1];
  const modified = parts.some((p) => p === "Ctrl" || p === "Alt" || p === "Meta");
  if (modified) return false;
  return /^(Key|Digit|Numpad\d)|^(Space|Enter|Backspace|Tab|Delete|Minus|Equal|Bracket|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote|Arrow|Home|End|PageUp|PageDown|IntlBackslash)/.test(code);
}

/** Readable label: "Ctrl+KeyB" → "Ctrl+B", "MediaPlayPause" → "Play/Pause". */
export function comboLabel(combo: string): string {
  return combo
    .split("+")
    .map((p) =>
      p
        .replace(/^Key([A-Z])$/, "$1")
        .replace(/^Digit(\d)$/, "$1")
        .replace(/^Numpad(\d)$/, "Num $1")
        .replace(/^MediaPlayPause$/, "Play/Pause")
        .replace(/^MediaTrackPrevious$/, "Previous track")
        .replace(/^MediaTrackNext$/, "Next track")
        .replace(/^Arrow(\w+)$/, "$1"),
    )
    .join("+");
}
