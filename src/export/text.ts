import type { Paragraph, Transcript } from "../lib/types";
import { formatClock, paragraphText, speakerName } from "../lib/transcript";
import { headerFields, type RenderOptions } from "./common";

/** Plain text: header lines, a blank line, then "Speaker [m:ss]: text" per turn. */
export function toTxt(transcript: Transcript, options: RenderOptions): string {
  const header = [
    options.projectName,
    ...headerFields(transcript, options).map((f) => `${f.label}: ${f.value}`),
  ].join("\n");
  const turns = transcript.paragraphs.map((p, i) => {
    const number = options.numbering === "none" ? "" : `${i + 1}. `;
    const time = options.timestamps ? ` [${formatClock(p.start)}]` : "";
    return `${number}${speakerName(transcript, p.speaker)}${time}: ${paragraphText(p, transcript)}`;
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
  const turn = (p: Paragraph, i: number) => {
    const number = options.numbering === "none" ? "" : `${i + 1}. `;
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
