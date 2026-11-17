import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { pseudonymMatches } from "./plugins";

// A minimal document of turns holding text, like the editor's.
const schema = new Schema({
  nodes: { doc: { content: "turn+" }, turn: { content: "text*" }, text: {} },
});
const doc = (...turns: string[]) => schema.node("doc", null, turns.map((t) => schema.node("turn", null, t ? [schema.text(t)] : [])));

describe("pseudonym preview", () => {
  it("finds whole words case-insensitively, longest rule first, without overlaps", () => {
    const d = doc("Jan de Vries zei dat jan en Janneke kwamen.", "Ook Anton.");
    const hits = pseudonymMatches(d, [
      { find: "Jan de Vries", replace: "[collega 1]" },
      { find: "Jan", replace: "[collega 2]" },
      { find: "Anton", replace: "" },
    ]);
    const text = (h: { from: number; to: number }) => d.textBetween(h.from, h.to);
    expect(hits.map((h) => [text(h), h.replace])).toEqual([
      ["Jan de Vries", "[collega 1]"],
      ["jan", "[collega 2]"],
      ["Anton", ""],
    ]);
  });

  it("ignores empty rules", () => {
    expect(pseudonymMatches(doc("Jan"), [{ find: "  ", replace: "x" }])).toEqual([]);
  });
});
