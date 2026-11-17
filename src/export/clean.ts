// A clean reading version of a verbatim transcript: no filler words, no pause tags and no
// listening sounds of the other speaker. Annotations such as [lacht] stay. Punctuation that
// was attached to a removed filler moves to the previous word, and a sentence that began with
// a filler starts with a capital again.

import type { Item, Paragraph, Transcript } from "../lib/types";

const SENTENCE_END = /[.?!]$/;

function capitalise(text: string): string {
  const i = text.search(/\p{L}/u);
  return i < 0 ? text : text.slice(0, i) + text[i].toUpperCase() + text.slice(i + 1);
}

function cleanParagraph(p: Paragraph): Paragraph | null {
  const out: Item[] = [];
  let capitalNext = false;
  let atStart = true;
  for (const item of p.items) {
    if (item.k === "p" || item.k === "b") continue;
    if (item.k === "w" && item.f) {
      const punct = item.t.match(/[.?!]+$/)?.[0];
      const lastWord = [...out].reverse().find((x) => x.k === "w");
      if (punct && lastWord && lastWord.k === "w" && !SENTENCE_END.test(lastWord.t)) {
        lastWord.t = lastWord.t.replace(/[,;:]$/, "") + punct;
      }
      // A filler that opened a sentence: the next word opens it now.
      if (atStart || (lastWord?.k === "w" && SENTENCE_END.test(lastWord.t))) capitalNext = true;
      continue;
    }
    if (item.k === "w") {
      const word = { ...item, t: capitalNext ? capitalise(item.t) : item.t };
      capitalNext = false;
      out.push(word);
    } else {
      out.push(item);
    }
    atStart = false;
  }
  return out.some((x) => x.k === "w" || x.k === "n") ? { ...p, items: out } : null;
}

export function cleanTranscript(t: Transcript): Transcript {
  return { ...t, paragraphs: t.paragraphs.map(cleanParagraph).filter((p): p is Paragraph => p !== null) };
}
