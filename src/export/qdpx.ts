// REFI-QDA project exchange (.qdpx): one file with a whole study, readable by ATLAS.ti,
// MAXQDA, NVivo, QDA Miner, Quirkos, QualCoder and others.
//
// The file is a zip with project.qde (QDA-XML 1.0, see the official Project.xsd of 18 March
// 2019) and the transcripts as plain text in sources/. What goes in:
// - every interview as a text source, with its notes as description and its details as
//   document variables (participant, date, interviewer, duration);
// - every participant as a case with the participant attributes as case variables;
// - every interview tag as a set (document group) of the interviews that carry it;
// - annotations in the text such as [lacht] as codes, coded at the exact spot.
//
// The transcripts are text only: the analysis programs do not reliably keep the link between
// a transcript and its audio through this format. For that, export with timestamps instead.

import { strToU8, zipSync } from "fflate";
import type { Language, Project, Study, Transcript } from "../lib/types";
import { itemText, speakerName } from "../lib/transcript";

export interface QdpxInterview {
  project: Project;
  transcript: Transcript;
  /** Interview date as YYYY-MM-DD. */
  date: string;
}

const LABELS: Record<Language, { participant: string; date: string; interviewer: string; duration: string }> = {
  nl: { participant: "Deelnemer", date: "Datum", interviewer: "Interviewer", duration: "Duur (min)" },
  en: { participant: "Participant", date: "Date", interviewer: "Interviewer", duration: "Duration (min)" },
};

const CODE_COLORS = ["#4F46E5", "#0F766E", "#B45309", "#BE185D", "#2563EB", "#7C3AED", "#15803D", "#C2410C"];

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Characters XML 1.0 does not allow.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function guid(): string {
  return crypto.randomUUID();
}

/** Length in characters as QDA programs count them (code points). */
const len = (s: string) => Array.from(s).length;

interface Selection {
  start: number;
  end: number;
  code: string;
}

/** The transcript as plain text ("Speaker: text" per turn) and where each annotation is. */
export function transcriptText(t: Transcript): { text: string; selections: Selection[] } {
  let text = "";
  const selections: Selection[] = [];
  t.paragraphs.forEach((p, i) => {
    if (i > 0) text += "\n\n";
    text += `${speakerName(t, p.speaker)}: `;
    p.items.forEach((item, k) => {
      if (k > 0) text += " ";
      const piece = itemText(item, t);
      if (item.k === "n") {
        const name = piece.replace(/^\[|\]$/g, "").trim();
        if (name) selections.push({ start: len(text), end: len(text) + len(piece), code: name });
      }
      text += piece;
    });
  });
  return { text: text + "\n", selections };
}

export function buildQdpx(study: Study | null, interviews: QdpxInterview[], options: { uiLanguage: Language; projectName: string; version: string }): Uint8Array {
  const L = LABELS[options.uiLanguage];
  const now = new Date().toISOString();
  const user = guid();
  const files: Record<string, Uint8Array> = {};

  // ---- texts, and the codes used in them
  const codeGuids = new Map<string, string>();
  const prepared = interviews.map((iv) => {
    const { text, selections } = transcriptText(iv.transcript);
    for (const s of selections) {
      const key = s.code.toLowerCase();
      if (!codeGuids.has(key)) codeGuids.set(key, guid());
    }
    const sourceGuid = guid();
    files[`sources/${sourceGuid}.txt`] = strToU8(text);
    return { iv, sourceGuid, selections };
  });
  const codeNames = new Map<string, string>();
  for (const p of prepared) for (const s of p.selections) if (!codeNames.has(s.code.toLowerCase())) codeNames.set(s.code.toLowerCase(), s.code);

  // ---- variables
  const v = { participant: guid(), date: guid(), interviewer: guid(), duration: guid() };
  const attributes = (study?.attributes ?? []).map((name) => ({ name, guid: guid() }));

  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="utf-8"?>');
  out.push(
    `<Project xmlns="urn:QDA-XML:project:1.0" name="${esc(options.projectName)}" origin="Polarity Transcribe ${esc(options.version)}" creatingUserGUID="${user}" creationDateTime="${now}" modifyingUserGUID="${user}" modifiedDateTime="${now}">`,
  );
  out.push(`<Users><User guid="${user}" name="${esc(study?.interviewer || "Polarity Transcribe")}"/></Users>`);

  if (codeGuids.size > 0) {
    out.push("<CodeBook><Codes>");
    [...codeGuids].forEach(([key, g], i) => {
      out.push(`<Code guid="${g}" name="${esc(codeNames.get(key) ?? key)}" isCodable="true" color="${CODE_COLORS[i % CODE_COLORS.length]}"/>`);
    });
    out.push("</Codes></CodeBook>");
  }

  out.push("<Variables>");
  out.push(`<Variable guid="${v.participant}" name="${esc(L.participant)}" typeOfVariable="Text"/>`);
  out.push(`<Variable guid="${v.date}" name="${esc(L.date)}" typeOfVariable="Date"/>`);
  out.push(`<Variable guid="${v.interviewer}" name="${esc(L.interviewer)}" typeOfVariable="Text"/>`);
  out.push(`<Variable guid="${v.duration}" name="${esc(L.duration)}" typeOfVariable="Float"/>`);
  for (const a of attributes) out.push(`<Variable guid="${a.guid}" name="${esc(a.name)}" typeOfVariable="Text"/>`);
  out.push("</Variables>");

  // ---- cases: the participants who took part in at least one exported interview
  const participants = (study?.participants ?? []).filter((p) => prepared.some((x) => x.iv.project.participantIds.includes(p.id)));
  if (participants.length > 0) {
    out.push("<Cases>");
    for (const p of participants) {
      out.push(`<Case guid="${guid()}" name="${esc(p.code)}">`);
      if (p.notes.trim()) out.push(`<Description>${esc(p.notes)}</Description>`);
      for (const a of attributes) {
        const value = p.attributes[a.name]?.trim();
        if (value) out.push(`<VariableValue><VariableRef targetGUID="${a.guid}"/><TextValue>${esc(value)}</TextValue></VariableValue>`);
      }
      for (const x of prepared.filter((x) => x.iv.project.participantIds.includes(p.id))) out.push(`<SourceRef targetGUID="${x.sourceGuid}"/>`);
      out.push("</Case>");
    }
    out.push("</Cases>");
  }

  // ---- sources
  if (prepared.length > 0) {
    out.push("<Sources>");
    for (const { iv, sourceGuid, selections } of prepared) {
      const project = iv.project;
      out.push(
        `<TextSource guid="${sourceGuid}" name="${esc(project.name)}" plainTextPath="internal://${sourceGuid}.txt" creatingUser="${user}" creationDateTime="${now}">`,
      );
      if (project.notes.trim()) out.push(`<Description>${esc(project.notes)}</Description>`);
      for (const s of selections) {
        out.push(
          `<PlainTextSelection guid="${guid()}" name="${esc(s.code)}" startPosition="${s.start}" endPosition="${s.end}" creatingUser="${user}" creationDateTime="${now}">` +
            `<Coding guid="${guid()}" creatingUser="${user}" creationDateTime="${now}"><CodeRef targetGUID="${codeGuids.get(s.code.toLowerCase())}"/></Coding>` +
            "</PlainTextSelection>",
        );
      }
      const codes = project.participantIds
        .map((id) => study?.participants.find((p) => p.id === id)?.code)
        .filter(Boolean)
        .join(", ");
      if (codes) out.push(`<VariableValue><VariableRef targetGUID="${v.participant}"/><TextValue>${esc(codes)}</TextValue></VariableValue>`);
      out.push(`<VariableValue><VariableRef targetGUID="${v.date}"/><DateValue>${iv.date}</DateValue></VariableValue>`);
      if (project.interviewer.trim()) {
        out.push(`<VariableValue><VariableRef targetGUID="${v.interviewer}"/><TextValue>${esc(project.interviewer)}</TextValue></VariableValue>`);
      }
      const minutes = Math.round((iv.transcript.duration / 60) * 10) / 10;
      out.push(`<VariableValue><VariableRef targetGUID="${v.duration}"/><FloatValue>${minutes}</FloatValue></VariableValue>`);
      out.push("</TextSource>");
    }
    out.push("</Sources>");
  }

  // ---- sets: one per interview tag
  const tags = [...new Set(prepared.flatMap((x) => x.iv.project.tags))].sort((a, b) => a.localeCompare(b));
  if (tags.length > 0) {
    out.push("<Sets>");
    for (const tag of tags) {
      out.push(`<Set guid="${guid()}" name="${esc(tag)}">`);
      for (const x of prepared.filter((x) => x.iv.project.tags.includes(tag))) out.push(`<MemberSource targetGUID="${x.sourceGuid}"/>`);
      out.push("</Set>");
    }
    out.push("</Sets>");
  }

  if (study?.notes.trim()) out.push(`<Description>${esc(study.notes)}</Description>`);
  out.push("</Project>");

  files["project.qde"] = strToU8(out.join("\n"));
  return zipSync(files, { level: 6 });
}
