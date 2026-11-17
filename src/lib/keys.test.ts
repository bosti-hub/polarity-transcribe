import { describe, expect, it } from "vitest";
import { comboLabel, isTypingKey, keyCombo } from "./keys";

const ev = (code: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: "", code, ...mods,
});

describe("keys", () => {
  it("records modifiers and the physical key", () => {
    expect(keyCombo(ev("F9"))).toBe("F9");
    expect(keyCombo(ev("KeyB", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+KeyB");
    expect(keyCombo(ev("MediaPlayPause"))).toBe("MediaPlayPause");
  });

  it("refuses keys that are needed for typing, unless combined with Ctrl or Alt", () => {
    for (const combo of ["KeyA", "Shift+KeyA", "Digit1", "Space", "Enter", "Backspace", "ArrowLeft", "Comma"]) expect(isTypingKey(combo)).toBe(true);
    for (const combo of ["F9", "Ctrl+KeyB", "Alt+Space", "MediaPlayPause", "Pause", "ScrollLock"]) expect(isTypingKey(combo)).toBe(false);
  });

  it("shows readable labels", () => {
    expect(comboLabel("Ctrl+Shift+KeyB")).toBe("Ctrl+Shift+B");
    expect(comboLabel("MediaPlayPause")).toBe("Play/Pause");
    expect(comboLabel("Alt+ArrowLeft")).toBe("Alt+Left");
  });
});
