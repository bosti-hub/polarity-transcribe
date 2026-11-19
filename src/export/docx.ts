import {
  AlignmentType,
  Document,
  Footer,
  HeadingLevel,
  LineNumberRestartFormat,
  Packer,
  PageNumber,
  Paragraph as DocxParagraph,
  TextRun,
} from "docx";
import type { Item, Paragraph, Transcript } from "../lib/types";
import { formatClock, itemText, speakerName } from "../lib/transcript";
import { headerFields, labelsTurns, type RenderOptions } from "./common";

/** Named styles, so users can restyle a whole transcript in Word, NVivo or ATLAS.ti. */
export const STYLE = {
  transcript: "Transcript",
  metadata: "Metadata",
  speaker: "Speaker",
  timestamp: "Timestamp",
  turnNumber: "TurnNumber",
  filler: "Filler",
  annotation: "Annotation",
} as const;

/** Millimetres to twips, rounded (docx's own helper truncates: A4 would become 11905 wide). */
const mmToTwip = (mm: number) => Math.round((mm / 25.4) * 1440);

const FONT = "Calibri";
const GREY = "808080";
const TEAL = "0F766E";
/** 1.15 line spacing, in 240ths of a line. */
const LINE_115 = 276;
/** Hanging indent that holds the turn number when numbering by paragraph. */
const NUMBER_INDENT = mmToTwip(10);

/** Character style for an item, or undefined for plain spoken words. */
function itemStyle(item: Item): string | undefined {
  if (item.k === "w") return item.f ? STYLE.filler : undefined;
  return STYLE.annotation;
}

/** Runs for the paragraph text; adjacent items with the same style share one run. */
function textRuns(p: Paragraph, transcript: Transcript): TextRun[] {
  const segments: { style: string | undefined; text: string }[] = [];
  for (const item of p.items) {
    const style = itemStyle(item);
    const text = itemText(item, transcript);
    const last = segments[segments.length - 1];
    if (last && last.style === style) last.text += ` ${text}`;
    else {
      // The separating space ends the preceding run, so hiding a style leaves no double spaces.
      if (last) last.text += " ";
      segments.push({ style, text });
    }
  }
  return segments.map((s) => new TextRun({ text: s.text, style: s.style }));
}

function turnParagraph(p: Paragraph, index: number, transcript: Transcript, options: RenderOptions): DocxParagraph {
  const numbered = options.numbering === "paragraph";
  const children: TextRun[] = [];
  if (numbered) {
    // The tab jumps to the hanging indent, so wrapped lines align with the speaker name.
    children.push(new TextRun({ text: String(index + 1), style: STYLE.turnNumber }), new TextRun({ text: "\t" }));
  }
  // With a single speaker (a lecture) the name would only repeat itself.
  const lead: TextRun[] = [];
  if (labelsTurns(transcript)) lead.push(new TextRun({ text: `${speakerName(transcript, p.speaker)}:`, style: STYLE.speaker }));
  if (options.timestamps) lead.push(new TextRun({ text: `[${formatClock(p.start)}]`, style: STYLE.timestamp }));
  lead.forEach((run, i) => children.push(...(i > 0 ? [new TextRun({ text: " " })] : []), run));
  if (lead.length > 0) children.push(new TextRun({ text: " " }));
  children.push(...textRuns(p, transcript));
  return new DocxParagraph({
    style: STYLE.transcript,
    children,
    indent: numbered ? { left: NUMBER_INDENT, hanging: NUMBER_INDENT } : undefined,
  });
}

function headerParagraphs(transcript: Transcript, options: RenderOptions): DocxParagraph[] {
  const fields = headerFields(transcript, options);
  return [
    new DocxParagraph({
      heading: HeadingLevel.TITLE,
      suppressLineNumbers: true,
      children: [new TextRun(options.projectName)],
    }),
    ...fields.map(
      (f, i) =>
        new DocxParagraph({
          style: STYLE.metadata,
          suppressLineNumbers: true,
          spacing: i === fields.length - 1 ? { after: 360 } : undefined,
          children: [new TextRun({ text: `${f.label}: `, bold: true }), new TextRun(f.value)],
        }),
    ),
  ];
}

/** Builds the Word document and returns its bytes. */
export async function toDocx(transcript: Transcript, options: RenderOptions): Promise<Uint8Array> {
  const margin = mmToTwip(25);
  const doc = new Document({
    title: options.projectName,
    creator: "Polarity Transcribe",
    styles: {
      default: {
        document: {
          run: { font: FONT, size: 22 },
          paragraph: { spacing: { line: LINE_115, after: 160 } },
        },
        title: {
          run: { font: FONT, size: 40, bold: true, color: "000000" },
          paragraph: { spacing: { after: 160 } },
        },
      },
      paragraphStyles: [
        {
          id: STYLE.transcript,
          name: STYLE.transcript,
          basedOn: "Normal",
          next: STYLE.transcript,
          quickFormat: true,
          paragraph: { spacing: { line: LINE_115, after: 160 } },
        },
        {
          id: STYLE.metadata,
          name: STYLE.metadata,
          basedOn: "Normal",
          quickFormat: true,
          run: { size: 20 },
          paragraph: { spacing: { line: LINE_115, after: 0 } },
        },
      ],
      characterStyles: [
        { id: STYLE.speaker, name: STYLE.speaker, quickFormat: true, run: { bold: true } },
        { id: STYLE.timestamp, name: STYLE.timestamp, quickFormat: true, run: { size: 18, color: GREY } },
        { id: STYLE.turnNumber, name: "Turn number", quickFormat: true, run: { size: 18, color: GREY } },
        { id: STYLE.filler, name: STYLE.filler, quickFormat: true, run: { italics: true, color: GREY } },
        { id: STYLE.annotation, name: STYLE.annotation, quickFormat: true, run: { italics: true, color: TEAL } },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: mmToTwip(210), height: mmToTwip(297) },
            margin: { top: margin, right: margin, bottom: margin, left: margin },
          },
          lineNumbers:
            options.numbering === "line"
              ? { countBy: 1, restart: LineNumberRestartFormat.CONTINUOUS, distance: mmToTwip(5) }
              : undefined,
        },
        footers: {
          default: new Footer({
            children: [
              new DocxParagraph({
                alignment: AlignmentType.CENTER,
                suppressLineNumbers: true,
                children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: GREY })],
              }),
            ],
          }),
        },
        children: [
          ...headerParagraphs(transcript, options),
          ...transcript.paragraphs.map((p, i) => turnParagraph(p, i, transcript, options)),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toArrayBuffer(doc));
}
