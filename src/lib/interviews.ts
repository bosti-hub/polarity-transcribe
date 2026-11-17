// Helpers shared by the library, the setup screen and the editor: where an interview stands,
// its date and its participants.

import type { TKey } from "./i18n";
import type { JobProgress, Project, Study } from "./types";

/** One step in an interview's life, from importing to done. */
export type Stage = "importing" | "setup" | "failed" | "queued" | "processing" | "paused" | "todo" | "checked" | "anonymised" | "done";

/** Groups of stages for filtering the interview list, in workflow order. */
export const STAGE_GROUPS: { id: string; label: TKey; stages: Stage[] }[] = [
  { id: "prepare", label: "home.statusSetup", stages: ["importing", "setup", "failed"] },
  { id: "running", label: "home.statusProcessing", stages: ["queued", "processing", "paused"] },
  { id: "todo", label: "interview.review_todo", stages: ["todo"] },
  { id: "checked", label: "interview.review_checked", stages: ["checked"] },
  { id: "anonymised", label: "interview.review_anonymised", stages: ["anonymised"] },
  { id: "done", label: "interview.review_done", stages: ["done"] },
];

export function stageOf(p: Project, job: JobProgress | undefined, queued: boolean, importing: boolean): Stage {
  if (importing) return "importing";
  if (queued) return "queued";
  switch (p.status) {
    case "setup":
      return "setup";
    case "failed":
      return "failed";
    case "processing":
      return job?.state === "running" ? "processing" : "paused";
    case "ready":
      return p.review;
  }
}

export const STAGE_STYLE: Record<Stage, { label: TKey; tone: "neutral" | "accent" | "ok" | "warn" | "danger" }> = {
  importing: { label: "library.importing", tone: "neutral" },
  setup: { label: "home.statusSetup", tone: "neutral" },
  failed: { label: "home.statusFailed", tone: "danger" },
  queued: { label: "library.queued", tone: "accent" },
  processing: { label: "home.statusProcessing", tone: "accent" },
  paused: { label: "home.statusPaused", tone: "warn" },
  todo: { label: "interview.review_todo", tone: "warn" },
  checked: { label: "interview.review_checked", tone: "accent" },
  anonymised: { label: "interview.review_anonymised", tone: "accent" },
  done: { label: "interview.review_done", tone: "ok" },
};

/** The interview date: set by hand, else the recording file's date, else when it was added. */
export function interviewDate(p: Project): Date {
  if (p.interviewDate) {
    const [y, m, d] = p.interviewDate.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  const fileDate = p.sources.find((s) => s?.modifiedMs)?.modifiedMs;
  return new Date(fileDate ?? p.createdAt);
}

/** "YYYY-MM-DD" in local time. */
export function isoDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Codes of the interview's participants ("R01, R02"). */
export function participantCodes(p: Project, study: Study | undefined): string {
  if (!study) return "";
  return p.participantIds
    .map((id) => study.participants.find((x) => x.id === id)?.code)
    .filter(Boolean)
    .join(", ");
}

/**
 * Where the transcribed part starts in the original recording (the start trim of the main
 * recording), so exported times can match the file the researcher keeps.
 */
export function recordingOffset(p: Project): number {
  return p.sources.find((s) => s !== null)?.trimStart ?? 0;
}

/** Date, interview details and time offset for exporting an interview. */
export function exportContext(p: Project, study: Study | undefined) {
  return {
    projectName: p.name,
    date: interviewDate(p),
    meta: { study: study?.name, participant: participantCodes(p, study), interviewer: p.interviewer },
    offset: recordingOffset(p),
  };
}

/** Interviews that can be transcribed right away: a recording, nothing running or queued. */
export function canQueue(p: Project, stage: Stage): boolean {
  return (stage === "setup" || stage === "failed" || stage === "paused") && p.sources.some(Boolean);
}
