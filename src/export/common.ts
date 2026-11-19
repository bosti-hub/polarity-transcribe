import type { Language, Transcript } from "../lib/types";
import { formatDuration } from "../lib/transcript";

/** A labelled line of the summary header ("Datum: 5 maart 2026"). */
export interface HeaderField {
  label: string;
  value: string;
}

/** The subset of export options the header needs. */
export interface HeaderOptions {
  date: Date;
  uiLanguage: Language;
  /** Interview details shown in the header when known. */
  meta?: InterviewMeta;
}

export interface InterviewMeta {
  study?: string;
  participant?: string;
  interviewer?: string;
}

/** Everything a renderer needs besides the transcript. */
export interface RenderOptions extends HeaderOptions {
  projectName: string;
  timestamps: boolean;
  numbering: "none" | "paragraph" | "line";
}

const LABELS: Record<
  Language,
  { date: string; duration: string; speakers: string; language: string; study: string; participant: string; interviewer: string }
> = {
  nl: { date: "Datum", duration: "Duur", speakers: "Sprekers", language: "Taal", study: "Studie", participant: "Deelnemer", interviewer: "Interviewer" },
  en: { date: "Date", duration: "Duration", speakers: "Speakers", language: "Language", study: "Study", participant: "Participant", interviewer: "Interviewer" },
};

const LANGUAGE_NAMES: Record<Language, Record<Language, string>> = {
  nl: { nl: "Nederlands", en: "Engels" },
  en: { nl: "Dutch", en: "English" },
};

/** Long, localised calendar date, e.g. "5 maart 2026" / "5 March 2026". */
export function formatLongDate(date: Date, lang: Language): string {
  return new Intl.DateTimeFormat(lang === "nl" ? "nl-NL" : "en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

/** Local calendar date as "YYYY-MM-DD". */
export function isoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Date, duration, speakers and language, labelled in the UI language. */
export function headerFields(transcript: Transcript, options: HeaderOptions): HeaderField[] {
  const labels = LABELS[options.uiLanguage];
  const meta = options.meta ?? {};
  const optional = (label: string, value: string | undefined): HeaderField[] => (value?.trim() ? [{ label, value: value.trim() }] : []);
  return [
    ...optional(labels.study, meta.study),
    ...optional(labels.participant, meta.participant),
    { label: labels.date, value: formatLongDate(options.date, options.uiLanguage) },
    ...optional(labels.interviewer, meta.interviewer),
    { label: labels.duration, value: formatDuration(transcript.duration) },
    { label: labels.speakers, value: transcript.speakers.map((s) => s.name).join(", ") },
    { label: labels.language, value: LANGUAGE_NAMES[options.uiLanguage][transcript.language] },
  ];
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Turns a project name into a file name that is valid on Windows, macOS and Linux. */
export function sanitizeFileName(name: string, extension: string): string {
  let base = name
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, "");
  if (base === "") base = "transcript";
  if (WINDOWS_RESERVED.test(base)) base = `_${base}`;
  return `${base}.${extension}`;
}

/** Longest name part of the file name, in characters; the date and time come after it. */
const MAX_NAME = 60;

/** Local date and time as "2026-11-19 1430": sorts by time and tells versions apart. */
export function stamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/**
 * File name of an export: the interview's or study's name without characters that are not
 * allowed in file names, shortened (at a word where possible), then the date and time.
 */
export function shareFileName(name: string, date: Date): string {
  let base = name
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(base);
  if (chars.length > MAX_NAME) {
    const cut = chars.slice(0, MAX_NAME).join("");
    const space = cut.lastIndexOf(" ");
    base = space > MAX_NAME / 2 ? cut.slice(0, space) : cut;
  }
  base = base.replace(/[. ]+$/, "") || "Polarity Transcribe";
  // With the date after it, the name is never a reserved Windows name such as "CON".
  return `${base} ${stamp(date)}.zip`;
}
