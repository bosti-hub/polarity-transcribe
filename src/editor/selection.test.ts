import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { selectedPhrase, sentenceCount, wholeWords } from "./plugins";

// A minimal document of turns holding text, like the editor's.
const schema = new Schema({
  nodes: { doc: { content: "turn+" }, turn: { content: "text*" }, text: {} },
});
const doc = (...turns: string[]) => schema.node("doc", null, turns.map((t) => schema.node("turn", null, t ? [schema.text(t)] : [])));

/** Positions of `part` inside the first turn (text starts at position 1). */
const at = (text: string, part: string, offset = 0) => 1 + text.indexOf(part) + offset;

function selecting(d: ReturnType<typeof doc>, from: number, to: number) {
  return EditorState.create({ doc: d, selection: TextSelection.create(d, from, to) });
}

describe("selections in the transcript", () => {
  const text = "Dus Jan de Vries zei: ja, klopt.";
  const d = doc(text, "Tweede beurt.");

  it("grows a selection that starts or ends inside a word", () => {
    const r = wholeWords(d, at(text, "Vries", 2), at(text, "zei", 1));
    expect(d.textBetween(r.from, r.to)).toBe("Vries zei");
  });

  it("does not pull in the next word after a double-click's trailing space", () => {
    const r = wholeWords(d, at(text, "Jan"), at(text, "Jan ", 4));
    expect(d.textBetween(r.from, r.to)).toBe("Jan ");
  });

  it("gives a short selection as a phrase without surrounding punctuation", () => {
    expect(selectedPhrase(selecting(d, at(text, "Jan"), at(text, "Vries", 5)))).toBe("Jan de Vries");
    expect(selectedPhrase(selecting(d, at(text, "ja,"), at(text, "klopt.", 6)))).toBe("ja, klopt");
  });

  it("counts sentences, so only a single one becomes an inline reply", () => {
    expect(sentenceCount("Ja, klopt.")).toBe(1);
    expect(sentenceCount("ja klopt")).toBe(1);
    expect(sentenceCount("Ja. Dat klopt helemaal.")).toBe(2);
    expect(sentenceCount("Echt? Ja! Zeker weten…  Goed.")).toBe(4);
    expect(sentenceCount("[eh]. Ja.")).toBe(2);
  });

  it("gives nothing for long selections, empty ones or ones across turns", () => {
    expect(selectedPhrase(selecting(d, at(text, "Dus"), at(text, "klopt", 5)))).toBe("");
    expect(selectedPhrase(selecting(d, at(text, "Jan"), at(text, "Jan")))).toBe("");
    expect(selectedPhrase(selecting(d, at(text, "klopt"), d.content.size - 2))).toBe("");
  });
});
