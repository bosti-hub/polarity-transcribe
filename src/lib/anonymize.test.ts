import { describe, expect, it } from "vitest";
import { anonymizeText, anonymizeTranscript, mergeRules, placeholderFor, pseudonymSpans, suggestCandidates } from "./anonymize";
import type { Item, Transcript } from "./types";

const w = (t: string, s: number): Item => ({ k: "w", t, s, e: s + 0.4, c: 0.9 });

function transcript(...turns: string[]): Transcript {
  return {
    version: 1,
    language: "nl",
    duration: 60,
    speakers: [
      { id: "S1", name: "Interviewer" },
      { id: "S2", name: "Alex" },
    ],
    paragraphs: turns.map((text, i) => ({
      id: `p${i}`,
      speaker: i % 2 ? "S2" : "S1",
      start: i * 10,
      end: i * 10 + 5,
      items: text.split(" ").map((t, k) => w(t, i * 10 + k * 0.5)),
    })),
  };
}

describe("rules", () => {
  it("merges interview and study rules, longest first, without duplicates", () => {
    const rules = mergeRules([{ find: "Jan", replace: "[A]" }], [{ find: "jan", replace: "[B]" }, { find: "Jan de Vries", replace: "[C]" }, { find: " ", replace: "x" }]);
    expect(rules).toEqual([
      { find: "Jan de Vries", replace: "[C]" },
      { find: "Jan", replace: "[A]" },
    ]);
  });

  it("replaces whole words only, case-insensitively", () => {
    const counts: number[] = [];
    expect(anonymizeText("Jan, jan en Janssen", [{ find: "Jan", replace: "[naam]" }], counts)).toBe("[naam], [naam] en Janssen");
    expect(counts).toEqual([2]);
  });
});

describe("anonymizeTranscript", () => {
  it("replaces names across words, keeps punctuation and timing, and renames speakers", () => {
    const t = transcript("Ik werk met Jan de Vries, hij komt uit Zuyderland.", "Ja, Alex hier.");
    const rules = mergeRules([], [
      { find: "Jan de Vries", replace: "[collega 1]" },
      { find: "Zuyderland", replace: "[ziekenhuis]" },
      { find: "Alex", replace: "[R01]" },
    ]);
    const { transcript: out, counts } = anonymizeTranscript(t, rules);
    const words = out.paragraphs[0].items.map((i) => (i.k === "w" ? i.t : "")).join(" ");
    expect(words).toBe("Ik werk met [collega 1], hij komt uit [ziekenhuis].");
    const merged = out.paragraphs[0].items[3];
    expect(merged).toMatchObject({ k: "w", t: "[collega 1],", s: 1.5 });
    expect(merged.k === "w" && merged.e).toBeCloseTo(2.9);
    expect(out.speakers[1].name).toBe("[R01]");
    expect(out.paragraphs[1].items.map((i) => (i.k === "w" ? i.t : "")).join(" ")).toBe("Ja, [R01] hier.");
    expect(counts).toEqual([1, 1, 2]);
    // The original is untouched.
    expect(t.paragraphs[0].items).toHaveLength(10);
  });
});

describe("suggestions", () => {
  it("finds names mid-sentence, dates, years, numbers, e-mail and phone numbers", () => {
    const t = transcript(
      "Toen zei Jan de Vries dat Petra het wist.",
      "Op 12 maart 2023 belde ik 06-12345678 en mailde jan@example.nl over 3512 JE.",
      "In 2019 werkte ik bij Zuyderland, dossier 4471923.",
    );
    const found = suggestCandidates(t, ["Zuyderland", "Leuven"], []);
    const terms = Object.fromEntries(found.map((c) => [c.term, c.kind]));
    expect(terms["Jan de Vries"]).toBe("name");
    expect(terms["Petra"]).toBe("name");
    expect(terms["12 maart 2023"]).toBe("date");
    expect(terms["2019"]).toBe("year");
    expect(terms["06-12345678"]).toBe("phone");
    expect(terms["jan@example.nl"]).toBe("email");
    expect(terms["3512 JE"]).toBe("postcode");
    expect(terms["4471923"]).toBe("number");
    expect(terms["Zuyderland"]).toBeDefined();
    // Not in the text, so not suggested; sentence starts and speaker names are not names.
    expect(terms["Leuven"]).toBeUndefined();
    expect(terms["Toen"]).toBeUndefined();
    expect(terms["Op"]).toBeUndefined();
  });

  it("leaves out what a rule already covers", () => {
    const t = transcript("Toen zei Petra dat Jan het wist.");
    const found = suggestCandidates(t, [], [{ find: "petra", replace: "[x]" }]);
    expect(found.map((c) => c.term)).toEqual(["Jan"]);
  });

  it("offers placeholders in the interview language", () => {
    expect(placeholderFor("name", "nl", 2)).toBe("[naam 2]");
    expect(placeholderFor("date", "en", 1)).toBe("[date]");
  });
});

describe("pseudonymSpans", () => {
  const w = (t: string, s: number, e: number) => ({ k: "w" as const, t, s, e, c: 1 });
  const t = {
    paragraphs: [
      { id: "a", speaker: "S1", start: 0, end: 6, items: [w("Ik", 0, 0.3), w("sprak", 0.3, 0.8), w("Jan", 0.8, 1.1), w("de", 1.1, 1.2), w("Vries", 1.2, 1.6), w("en", 1.7, 1.8), w("jan.", 1.8, 2.1)] },
      { id: "b", speaker: "S2", start: 10, end: 12, items: [w("Jan", 10, 10.4)] },
    ],
  };
  const rules = mergeRules([{ find: "Jan de Vries", replace: "[A]" }, { find: "Jan", replace: "[B]" }], []);

  it("gives the times of every match, multi-word ones as one span", () => {
    expect(pseudonymSpans(t, rules, 0, 6)).toEqual([
      [0.8, 1.6],
      [1.8, 2.1],
    ]);
  });

  it("only returns spans inside the fragment", () => {
    expect(pseudonymSpans(t, rules, 9, 13)).toEqual([[10, 10.4]]);
    expect(pseudonymSpans(t, [], 0, 13)).toEqual([]);
  });
});
