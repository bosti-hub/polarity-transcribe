// A quote list for writing up results: every saved quote with participant, interview and time.

import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import type { Language } from "../lib/types";

export interface QuoteLine {
  text: string;
  participant: string;
  interview: string;
  /** "12:34" on the original recording's clock. */
  time: string;
  note: string;
}

const HEADERS: Record<Language, string[]> = {
  nl: ["Citaat", "Deelnemer", "Interview", "Tijd", "Notitie"],
  en: ["Quote", "Participant", "Interview", "Time", "Note"],
};

export async function quotesDocx(title: string, lines: QuoteLine[]): Promise<Uint8Array> {
  const children: Paragraph[] = [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] })];
  for (const q of lines) {
    children.push(new Paragraph({ spacing: { before: 240, after: 40 }, children: [new TextRun({ text: `“${q.text}”`, italics: true })] }));
    const meta = [q.participant, q.interview, q.time].filter(Boolean).join(" · ");
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
  const sep = lang === "nl" ? ";" : ",";
  const cell = (v: string) => (/[",;\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = [HEADERS[lang], ...lines.map((q) => [q.text, q.participant, q.interview, q.time, q.note])];
  return "﻿" + rows.map((r) => r.map(cell).join(sep)).join("\r\n") + "\r\n";
}
