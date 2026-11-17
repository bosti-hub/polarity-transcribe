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

export const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);

/** The command key: ⌘ on a Mac, Ctrl elsewhere. Shortcuts are written with it as "Mod". */
export const MOD = isMac ? "⌘" : "Ctrl";

/** Mac symbols for modifier and special keys, in the order macOS menus show modifiers. */
const MAC_SYMBOLS: Record<string, string> = {
  Ctrl: "⌃",
  Control: "⌃",
  Alt: "⌥",
  Option: "⌥",
  Shift: "⇧",
  Meta: "⌘",
  Cmd: "⌘",
  "⌘": "⌘",
  Enter: "↩",
  Backspace: "⌫",
  Delete: "⌦",
  Tab: "⇥",
};
const MAC_ORDER = ["⌃", "⌥", "⇧", "⌘"];

/** One key in the platform's notation: "Alt" → "⌥" on a Mac, unchanged elsewhere. */
export function keyName(key: string, mac = isMac): string {
  return mac ? (MAC_SYMBOLS[key] ?? key) : key;
}

/** Keys pressed together, in the platform's order (on a Mac: ⌃ ⌥ ⇧ ⌘, then the key). */
export function orderKeys(keys: string[], mac = isMac): string[] {
  if (!mac) return keys;
  const rank = (k: string) => {
    const i = MAC_ORDER.indexOf(keyName(k, true));
    return i < 0 ? MAC_ORDER.length : i;
  };
  return [...keys].sort((a, b) => rank(a) - rank(b));
}

/**
 * A shortcut written as "Alt+←" or "⌘+Shift+Enter" in the platform's notation. On a Mac the
 * modifiers become symbols in the standard order without plus signs ("⌥←", "⇧⌘↩"), as in macOS
 * menus; elsewhere the plus signs stay ("Alt+←", "Ctrl+Shift+Enter"). "A or B" is kept as is.
 */
export function shortcutLabel(shortcut: string, mac = isMac): string {
  if (!mac) return shortcut;
  return shortcut
    .split(" / ")
    .map((alt) => {
      const parts = alt.split("+").map((p) => keyName(p, true));
      const mods = parts.filter((p) => MAC_ORDER.includes(p)).sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b));
      const rest = parts.filter((p) => !MAC_ORDER.includes(p));
      return mods.join("") + rest.join("+");
    })
    .join(" / ");
}

/** Readable label: "Ctrl+KeyB" → "Ctrl+B" ("⌃B" on a Mac), "MediaPlayPause" → "Play/Pause". */
export function comboLabel(combo: string, mac = isMac): string {
  return shortcutLabel(
    combo
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
      .join("+"),
    mac,
  );
}
