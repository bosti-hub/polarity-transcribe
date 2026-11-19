import type { Paragraph, Transcript } from "../lib/types";
import { formatClock, paragraphText, speakerName } from "../lib/transcript";
import { headerFields, labelsTurns, type RenderOptions } from "./common";

/** Plain text: header lines, a blank line, then "Speaker [m:ss]: text" per turn. */
export function toTxt(transcript: Transcript, options: RenderOptions): string {
  const header = [
    options.projectName,
    ...headerFields(transcript, options).map((f) => `${f.label}: ${f.value}`),
  ].join("\n");
  const named = labelsTurns(transcript);
  const turns = transcript.paragraphs.map((p, i) => {
    const number = options.numbering === "none" ? "" : `${i + 1}. `;
    const text = paragraphText(p, transcript);
    // A single speaker (a lecture): "[m:ss] text", the name would only repeat itself.
    if (!named) return `${number}${options.timestamps ? `[${formatClock(p.start)}] ` : ""}${text}`;
    const time = options.timestamps ? ` [${formatClock(p.start)}]` : "";
    return `${number}${speakerName(transcript, p.speaker)}${time}: ${text}`;
  });
  return [header, ...turns].join("\n\n") + "\n";
}

/** Escapes the Markdown characters that could change emphasis or inject HTML. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_<>]/g, "\\$&");
}

/** Markdown: "# Project", a metadata list, then "**Speaker** *(m:ss)*: text" per turn. */
export function toMarkdown(transcript: Transcript, options: RenderOptions): string {
  const meta = headerFields(transcript, options).map(
    (f) => `- **${f.label}:** ${escapeMarkdown(f.value)}`,
  );
  const named = labelsTurns(transcript);
  const turn = (p: Paragraph, i: number) => {
    const number = options.numbering === "none" ? "" : `${i + 1}. `;
    if (!named) {
      const time = options.timestamps ? `*(${formatClock(p.start)})* ` : "";
      return `${number}${time}${escapeMarkdown(paragraphText(p, transcript))}`;
    }
    const time = options.timestamps ? ` *(${formatClock(p.start)})*` : "";
    const name = escapeMarkdown(speakerName(transcript, p.speaker));
    return `${number}**${name}**${time}: ${escapeMarkdown(paragraphText(p, transcript))}`;
  };
  return [
    `# ${escapeMarkdown(options.projectName)}`,
    meta.join("\n"),
    ...transcript.paragraphs.map(turn),
  ].join("\n\n") + "\n";
}

/** A table, one turn per row: number, start, end, speaker, text. Semicolons for Dutch Excel. */
export function toCsv(transcript: Transcript, options: RenderOptions): string {
  const nl = options.uiLanguage === "nl";
  const sep = nl ? ";" : ",";
  const cell = (v: string) => (/[",;\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const header = nl ? ["Nr.", "Begin", "Einde", "Spreker", "Tekst"] : ["No.", "Start", "End", "Speaker", "Text"];
  const rows = transcript.paragraphs.map((p, i) => [String(i + 1), formatClock(p.start), formatClock(p.end), speakerName(transcript, p.speaker), paragraphText(p, transcript)]);
  return "﻿" + [header, ...rows].map((r) => r.map(cell).join(sep)).join("\r\n") + "\r\n";
}
