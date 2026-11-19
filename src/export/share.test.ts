import { describe, expect, it } from "vitest";
import { shareFileName, stamp } from "./common";

const at = new Date(2026, 10, 9, 8, 5);

describe("share file names", () => {
  it("adds the local date and time", () => {
    expect(stamp(at)).toBe("2026-11-09 0805");
    expect(shareFileName("Werkdruk in de zorg", at)).toBe("Werkdruk in de zorg 2026-11-09 0805.zip");
  });

  it("leaves out characters that are not allowed in file names", () => {
    expect(shareFileName('R03: "Jan" / Piet? <test>*|', at)).toBe("R03 Jan Piet test 2026-11-09 0805.zip");
    expect(shareFileName("Interview...", at)).toBe("Interview 2026-11-09 0805.zip");
  });

  it("shortens long names at a word", () => {
    const long = "Een heel lang interview over werkdruk, verloop en samenwerking in de wijkverpleging in Utrecht";
    const name = shareFileName(long, at);
    expect(name).toBe("Een heel lang interview over werkdruk, verloop en 2026-11-09 0805.zip");
    expect(Array.from(name.replace(/ 2026.*$/, "")).length).toBeLessThanOrEqual(60);
    // One long word is cut where it has to be.
    expect(shareFileName("x".repeat(100), at)).toBe(`${"x".repeat(60)} 2026-11-09 0805.zip`);
  });

  it("never splits a character or ends up empty", () => {
    expect(shareFileName("😀".repeat(70), at)).toBe(`${"😀".repeat(60)} 2026-11-09 0805.zip`);
    expect(shareFileName(' ?*" ', at)).toBe("Polarity Transcribe 2026-11-09 0805.zip");
  });
});
