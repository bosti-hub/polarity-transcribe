import type { Item, Language, Paragraph, Transcript } from "./types";

/** "[stilte 3.5s]" / "[silence 3.5s]" */
export function pauseLabel(lang: Language, seconds: number): string {
  const word = lang === "nl" ? "stilte" : "silence";
  return `[${word} ${seconds.toFixed(1)}s]`;
}

/** Matches a pause tag in either language and captures the duration. */
export const PAUSE_RE = /^\[(?:stilte|silence) (\d+(?:\.\d+)?)s\]$/;

export function speakerName(transcript: Pick<Transcript, "speakers">, id: string): string {
  return transcript.speakers.find((s) => s.id === id)?.name ?? id;
}

/** The text an item contributes to a paragraph. */
export function itemText(item: Item, transcript: Pick<Transcript, "speakers" | "language">): string {
  switch (item.k) {
    case "w":
      return item.t;
    case "p":
      return pauseLabel(transcript.language, item.e - item.s);
    case "b":
      return `[${speakerName(transcript, item.sp)}: ${item.t}]`;
    case "n":
      return item.t;
  }
}

export function paragraphText(p: Paragraph, transcript: Pick<Transcript, "speakers" | "language">): string {
  return p.items.map((it) => itemText(it, transcript)).join(" ");
}

/** 75.3 → "1:15", 3723 → "1:02:03" */
export function formatClock(seconds: number, withTenths = false): string {
  const t = Math.max(0, seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const sec = withTenths ? s.toFixed(1).padStart(4, "0") : String(Math.floor(s)).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** "1 h 12 min" / "12 min" / "45 s" */
export function formatDuration(seconds: number): string {
  const t = Math.round(seconds);
  if (t < 60) return `${t} s`;
  const h = Math.floor(t / 3600);
  const m = Math.round((t % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** Parses "1:02:03.5", "12:30" or "75" into seconds; null if it is not a time. */
export function parseClock(text: string): number | null {
  const parts = text.trim().replace(",", ".").split(":");
  if (parts.length === 0 || parts.length > 3) return null;
  let total = 0;
  for (const part of parts) {
    if (part === "" || !/^\d+(\.\d+)?$/.test(part)) return null;
    total = total * 60 + Number(part);
  }
  return total;
}

export function wordCount(transcript: Transcript): number {
  let n = 0;
  for (const p of transcript.paragraphs) for (const it of p.items) if (it.k === "w") n++;
  return n;
}
