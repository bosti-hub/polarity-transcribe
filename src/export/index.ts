import { anonymizeText, anonymizeTranscript } from "../lib/anonymize";
import type { AnonymizeRule, Language, Transcript } from "../lib/types";
import { cleanTranscript } from "./clean";
import { applyNotation, type PauseNotation } from "./notation";
import { isoDate, sanitizeFileName, type InterviewMeta } from "./common";
import { toDocx } from "./docx";
import { toNvivoDocx, toQdaDocx } from "./qda";
import { toSrt, toVtt } from "./srt";
import { toMarkdown, toTxt } from "./text";

export type ExportFormat = "docx" | "maxqda" | "nvivo" | "txt" | "md" | "srt" | "vtt" | "json";

/** File extension per format. */
export const EXTENSION: Record<ExportFormat, string> = {
  docx: "docx",
  maxqda: "docx",
  nvivo: "docx",
  txt: "txt",
  md: "md",
  srt: "srt",
  vtt: "vtt",
  json: "json",
};

/** Formats with a header, timestamps and numbering options (the reading formats). */
export const HAS_LAYOUT: ExportFormat[] = ["docx", "txt", "md"];

export interface ExportOptions {
  format: ExportFormat;
  projectName: string;
  /** Date shown in the header (project creation / interview date). */
  date: Date;
  /** Show a timestamp at the start of every paragraph. */
  timestamps: boolean;
  /** "paragraph" numbers each speaker turn; "line" uses Word's line numbering (docx only; other formats fall back to paragraph numbering). */
  numbering: "none" | "paragraph" | "line";
  /** Language for the labels in the header ("Datum"/"Date", …). */
  uiLanguage: Language;
  /** Study, participant and interviewer, shown in the header when known. */
  meta?: InterviewMeta;
  /** Leave out filler words, pause tags and listening sounds (a reading version). */
  clean?: boolean;
  /**
   * Seconds to add to every time, so times match the original recording when only part of it
   * was transcribed (the start trim).
   */
  offset?: number;
  /** Pseudonymise with these rules (text, speaker names and the title). */
  anonymize?: AnonymizeRule[];
  /** How pauses are written (subtitles always leave them out). */
  notation?: PauseNotation;
}

export interface ExportResult {
  bytes: Uint8Array;
  extension: string;
  fileName: string;
}

const encoder = new TextEncoder();

/** The transcript with every time moved by `offset` seconds. */
export function shiftTimes(t: Transcript, offset: number): Transcript {
  if (!offset) return t;
  const at = (x: number) => Math.round((x + offset) * 1000) / 1000;
  return {
    ...t,
    paragraphs: t.paragraphs.map((p) => ({
      ...p,
      start: at(p.start),
      end: at(p.end),
      items: p.items.map((it) => {
        if (it.k === "n") return it.s === undefined ? it : { ...it, s: at(it.s) };
        return { ...it, s: at(it.s), e: at(it.e) };
      }),
    })),
  };
}

/** The transcript as it goes into a file: pseudonymised and cleaned if asked, on the original recording's clock. */
export function prepare(transcript: Transcript, options: Pick<ExportOptions, "clean" | "offset" | "anonymize" | "notation">): Transcript {
  let t = transcript;
  if (options.anonymize?.length) t = anonymizeTranscript(t, options.anonymize).transcript;
  if (options.clean) t = cleanTranscript(t);
  if (options.notation) t = applyNotation(t, options.notation);
  return shiftTimes(t, options.offset ?? 0);
}

/** Renders the transcript in the requested format, entirely offline. */
export async function exportTranscript(transcript: Transcript, options: ExportOptions): Promise<ExportResult> {
  const extension = EXTENSION[options.format];
  const rules = options.anonymize ?? [];
  // The title and header can contain names too.
  const opts: ExportOptions = rules.length
    ? {
        ...options,
        projectName: anonymizeText(options.projectName, rules),
        meta: options.meta && { ...options.meta, interviewer: options.meta.interviewer && anonymizeText(options.meta.interviewer, rules) },
      }
    : options;
  const bytes = await render(transcript, opts);
  return { bytes, extension, fileName: sanitizeFileName(opts.projectName, extension) };
}

async function render(source: Transcript, options: ExportOptions): Promise<Uint8Array> {
  // Subtitles end a cue at a pause instead of writing it; the raw data keeps pauses as pauses.
  const keepPauses = options.format === "srt" || options.format === "vtt" || options.format === "json";
  const transcript = prepare(source, keepPauses ? { ...options, notation: undefined } : options);
  switch (options.format) {
    case "docx":
      return toDocx(transcript, options);
    case "maxqda":
      return toQdaDocx(transcript, options.projectName);
    case "nvivo":
      return toNvivoDocx(transcript, options.projectName, options.uiLanguage);
    case "txt":
      return encoder.encode(toTxt(transcript, options));
    case "md":
      return encoder.encode(toMarkdown(transcript, options));
    case "srt":
      return encoder.encode(toSrt(transcript));
    case "vtt":
      return encoder.encode(toVtt(transcript));
    case "json": {
      const payload = {
        generator: "Polarity Transcribe",
        exportedAt: new Date().toISOString(),
        project: options.projectName,
        date: isoDate(options.date),
        ...(options.meta ?? {}),
        clean: !!options.clean,
        pseudonymised: !!options.anonymize?.length,
        // Times in the transcript below already include this offset.
        timeOffset: options.offset ?? 0,
        transcript,
      };
      return encoder.encode(JSON.stringify(payload, null, 2) + "\n");
    }
  }
}
