// Transcripts for qualitative analysis software, with timestamps those programs read so the
// text stays linked to the recording after import.
//
// - MAXQDA and ATLAS.ti: "Speaker: text #hh:mm:ss-x#", the f4/f5 timestamp at the end of every
//   paragraph (x = tenths of a second). Both recognise this format on import.
// - NVivo: a Word table with a time span, speaker and content column, which NVivo's
//   "Import transcripts" maps to its own transcript rows.

import { Document, Packer, Paragraph as DocxParagraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import type { Language, Transcript } from "../lib/types";
import { paragraphText, speakerName } from "../lib/transcript";

/** 83.47 → "#00:01:23-5#" */
export function f4Stamp(seconds: number): string {
  const tenths = Math.max(0, Math.round(seconds * 10));
  const pad = (n: number) => String(n).padStart(2, "0");
  const s = Math.floor(tenths / 10);
  return `#${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}-${tenths % 10}#`;
}

/** 83.47 → "00:01:23" */
export function hms(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

const FONT = "Calibri";

/** MAXQDA / ATLAS.ti: one paragraph per turn, timestamp at its end. */
export async function toQdaDocx(transcript: Transcript, title: string): Promise<Uint8Array> {
  const paragraphs = transcript.paragraphs.map(
    (p) =>
      new DocxParagraph({
        spacing: { after: 160 },
        children: [
          new TextRun({ text: `${speakerName(transcript, p.speaker)}: `, bold: true }),
          new TextRun(`${paragraphText(p, transcript)} ${f4Stamp(p.end)}`),
        ],
      }),
  );
  const doc = new Document({
    title,
    creator: "Polarity Transcribe",
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    sections: [{ children: paragraphs }],
  });
  return new Uint8Array(await Packer.toArrayBuffer(doc));
}

/** The same as plain text (MAXQDA also imports .txt). */
export function toQdaTxt(transcript: Transcript): string {
  return transcript.paragraphs.map((p) => `${speakerName(transcript, p.speaker)}: ${paragraphText(p, transcript)} ${f4Stamp(p.end)}`).join("\n\n") + "\n";
}

const NVIVO_HEADERS: Record<Language, [string, string, string]> = {
  nl: ["Tijdsduur", "Spreker", "Inhoud"],
  en: ["Timespan", "Speaker", "Content"],
};

function cell(text: string, width: number, bold = false): TableCell {
  return new TableCell({
    width: { size: width, type: WidthType.PERCENTAGE },
    children: [new DocxParagraph({ children: [new TextRun({ text, bold })] })],
  });
}

/** NVivo: only a table (header row, then one row per turn), nothing else in the document. */
export async function toNvivoDocx(transcript: Transcript, title: string, uiLanguage: Language): Promise<Uint8Array> {
  const [span, speaker, content] = NVIVO_HEADERS[uiLanguage];
  const rows = [
    new TableRow({ tableHeader: true, children: [cell(span, 20, true), cell(speaker, 15, true), cell(content, 65, true)] }),
    ...transcript.paragraphs.map(
      (p) =>
        new TableRow({
          children: [cell(`${hms(p.start)} - ${hms(p.end)}`, 20), cell(speakerName(transcript, p.speaker), 15), cell(paragraphText(p, transcript), 65)],
        }),
    ),
  ];
  const doc = new Document({
    title,
    creator: "Polarity Transcribe",
    styles: { default: { document: { run: { font: FONT, size: 20 } } } },
    sections: [{ children: [new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows })] }],
  });
  return new Uint8Array(await Packer.toArrayBuffer(doc));
}
