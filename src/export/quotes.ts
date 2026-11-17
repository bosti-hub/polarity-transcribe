// A quote list for writing up results: every saved quote with participant, interview and time,
// optionally numbered and with the name of its audio fragment.

import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import type { Language } from "../lib/types";

export interface QuoteLine {
  text: string;
  participant: string;
  interview: string;
  /** "12:34" on the original recording's clock. */
  time: string;
  note: string;
  /** Number shown with the quote, for example "C01"; empty when not numbered. */
  label?: string;
  /** File name of the quote's audio fragment, when exported with audio. */
  audio?: string;
}

const HEADERS: Record<Language, { label: string; quote: string; participant: string; interview: string; time: string; note: string; audio: string }> = {
  nl: { label: "Nr.", quote: "Citaat", participant: "Deelnemer", interview: "Interview", time: "Tijd", note: "Notitie", audio: "Audio" },
  en: { label: "No.", quote: "Quote", participant: "Participant", interview: "Interview", time: "Time", note: "Note", audio: "Audio" },
};

/** Prefix of quote numbers: C01 (citaat) in Dutch, Q01 in English. */
export function quoteLabel(index: number, total: number, lang: Language): string {
  const width = Math.max(2, String(total).length);
  return `${lang === "nl" ? "C" : "Q"}${String(index + 1).padStart(width, "0")}`;
}

function metaLine(q: QuoteLine): string {
  return [q.participant, q.interview, q.time].filter(Boolean).join(" · ");
}

export async function quotesDocx(title: string, lines: QuoteLine[], lang: Language = "nl"): Promise<Uint8Array> {
  const h = HEADERS[lang];
  const children: Paragraph[] = [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] })];
  for (const q of lines) {
    const runs: TextRun[] = [];
    if (q.label) runs.push(new TextRun({ text: `${q.label}  `, bold: true }));
    runs.push(new TextRun({ text: `“${q.text}”`, italics: true }));
    children.push(new Paragraph({ spacing: { before: 240, after: 40 }, children: runs }));
    const meta = [metaLine(q), q.audio ? `${h.audio}: ${q.audio}` : ""].filter(Boolean).join(" · ");
    children.push(new Paragraph({ spacing: { after: q.note ? 20 : 120 }, children: [new TextRun({ text: meta, size: 18, color: "6B7280" })] }));
    if (q.note) children.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: q.note, size: 18 })] }));
  }
  const doc = new Document({
    title,
    creator: "Polarity Transcribe",
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [{ children }],
  });
  return new Uint8Array(await Packer.toArrayBuffer(doc));
}

export function quotesCsv(lines: QuoteLine[], lang: Language): string {
  const h = HEADERS[lang];
  const sep = lang === "nl" ? ";" : ",";
  const cell = (v: string) => (/[",;\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const numbered = lines.some((q) => q.label);
  const withAudio = lines.some((q) => q.audio);
  const header = [...(numbered ? [h.label] : []), h.quote, h.participant, h.interview, h.time, h.note, ...(withAudio ? [h.audio] : [])];
  const rows = [
    header,
    ...lines.map((q) => [...(numbered ? [q.label ?? ""] : []), q.text, q.participant, q.interview, q.time, q.note, ...(withAudio ? [q.audio ?? ""] : [])]),
  ];
  return "﻿" + rows.map((r) => r.map(cell).join(sep)).join("\r\n") + "\r\n";
}

/** Plain text, one quote per block; pastes cleanly into any document. */
export function quotesText(title: string, lines: QuoteLine[], lang: Language): string {
  const h = HEADERS[lang];
  const blocks = lines.map((q) => {
    const head = q.label ? `${q.label}  “${q.text}”` : `“${q.text}”`;
    const meta = [metaLine(q), q.audio ? `${h.audio}: ${q.audio}` : ""].filter(Boolean).join(" · ");
    return [head, meta, q.note].filter(Boolean).join("\n");
  });
  return [title, "", ...blocks.flatMap((b) => [b, ""])].join("\n");
}

/** Markdown: a heading, then each quote as a block quote with its details below. */
export function quotesMarkdown(title: string, lines: QuoteLine[], lang: Language): string {
  const h = HEADERS[lang];
  const esc = (s: string) => s.replace(/([\\`*_[\]<>#|])/g, "\\$1");
  const blocks = lines.map((q) => {
    const head = `> ${q.label ? `**${q.label}** ` : ""}“${esc(q.text)}”`;
    const meta = [esc(metaLine(q)), q.audio ? `${h.audio}: [${q.audio}](${encodeURI(q.audio)})` : ""].filter(Boolean).join(" · ");
    return [head, "", meta, q.note ? `\n${esc(q.note)}` : ""].join("\n");
  });
  return [`# ${esc(title)}`, "", ...blocks.flatMap((b) => [b.trimEnd(), ""])].join("\n");
}
