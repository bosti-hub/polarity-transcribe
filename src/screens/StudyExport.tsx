// Export a whole study into a folder: one transcript per interview in the chosen format, and
// optionally the participants table, a REFI-QDA project and the original recordings.

import { FolderDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button, Dialog, Progress, Switch } from "@/components/ui";
import { FormatOptions, FormatPicker, useNotation } from "@/editor/ExportDialog";
import { EXTENSION, exportTranscript, prepare, type ExportFormat, type ExportOptions } from "@/export";
import { sanitizeFileName } from "@/export/common";
import { buildQdpx, type QdpxInterview } from "@/export/qdpx";
import { anonymizeText, anonymizeTranscript, mergeRules } from "@/lib/anonymize";
import { api, errorMessage } from "@/lib/api";
import { translate, useT } from "@/lib/i18n";
import { exportContext, isoDay, interviewDate, participantCodes } from "@/lib/interviews";
import { pickFolder } from "@/lib/platform";
import { useApp } from "@/lib/store";
import type { Project, Study } from "@/lib/types";
import { participantsCsv } from "./Participants";

/** A file name that is unique within one export. */
function uniqueName(base: string, extension: string, used: Set<string>): string {
  let name = sanitizeFileName(base, extension);
  for (let i = 2; used.has(name.toLowerCase()); i++) name = sanitizeFileName(`${base} (${i})`, extension);
  used.add(name.toLowerCase());
  return name;
}

function join(dir: string, name: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

export function StudyExportDialog({ study, projects, onClose }: { study: Study | null; projects: Project[]; onClose: () => void }) {
  const t = useT();
  const uiLanguage = useApp((s) => s.settings.uiLanguage);
  const version = useApp((s) => s.info?.version ?? "");
  const [format, setFormat] = useState<ExportFormat>("maxqda");
  const [timestamps, setTimestamps] = useState(true);
  const [numbering, setNumbering] = useState<ExportOptions["numbering"]>("none");
  const [clean, setClean] = useState(false);
  const [csv, setCsv] = useState(true);
  const [qdpx, setQdpx] = useState(true);
  const [originals, setOriginals] = useState(false);
  const [onlyChecked, setOnlyChecked] = useState(false);
  const [anonymize, setAnonymize] = useState(true);
  const [notation, setNotation] = useNotation();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => setProgress(null), [study]);

  const ready = projects.filter((p) => p.status === "ready");
  const selected = useMemo(
    () => (onlyChecked ? ready.filter((p) => p.review !== "todo") : ready).sort((a, b) => interviewDate(a).getTime() - interviewDate(b).getTime()),
    [ready, onlyChecked],
  );

  const run = async () => {
    if (!study || selected.length === 0) return;
    const { toast } = useApp.getState();
    try {
      const parent = await pickFolder();
      if (!parent) return;
      const dir = join(parent, sanitizeFileName(study.name, "x").slice(0, -2));
      const used = new Set<string>();
      const forQdpx: QdpxInterview[] = [];
      let missing = 0;
      setProgress({ done: 0, total: selected.length });

      for (const [i, project] of selected.entries()) {
        const transcript = await api.loadTranscript(project.id);
        const rules = anonymize ? mergeRules((await api.loadExtras(project.id)).anonymize ?? [], study.pseudonyms) : [];
        const context = exportContext(project, study);
        const codes = participantCodes(project, study);
        const name = anonymizeText(project.name, rules);
        const base = codes ? `${codes} - ${name}` : name;
        const result = await exportTranscript(transcript, { ...context, format, timestamps, numbering, uiLanguage, clean, anonymize: rules, notation });
        await api.writeFile(join(dir, uniqueName(base, EXTENSION[format], used)), result.bytes);
        if (originals) {
          const original = project.sources.find((s) => s !== null);
          const ext = original?.fileName.split(".").pop() ?? "audio";
          const copied = await api.copyOriginal(project.id, join(join(dir, t("studyExport.audioFolder")), uniqueName(base, ext, used)));
          if (!copied) missing++;
        }
        // Names can also be in the interview's title, notes and interviewer.
        const safeProject = {
          ...project,
          name,
          notes: anonymizeText(project.notes, rules),
          interviewer: anonymizeText(project.interviewer, rules),
        };
        forQdpx.push({ project: safeProject, transcript: prepare(transcript, { clean, anonymize: rules, notation }), date: isoDay(interviewDate(project)) });
        setProgress({ done: i + 1, total: selected.length });
      }

      if (csv && study.participants.length > 0) {
        const text = "﻿" + participantsCsv(study, projects, uiLanguage === "nl" ? ";" : ",");
        await api.writeFile(join(dir, uniqueName(t("library.tabParticipants"), "csv", used)), new TextEncoder().encode(text));
      }
      if (qdpx) {
        const bytes = buildQdpx(study, forQdpx, { uiLanguage, projectName: study.name, version });
        await api.writeFile(join(dir, uniqueName(study.name, "qdpx", used)), bytes);
      }

      onClose();
      toast(t("studyExport.done", { n: selected.length, path: dir }), "ok", { label: t("export.show"), run: () => void api.revealInFolder(dir) });
      if (missing > 0) toast(t("studyExport.missingOriginals", { n: missing }), "error");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setProgress(null);
    }
  };

  const busy = progress !== null;
  return (
    <Dialog
      open={study !== null}
      onOpenChange={(o) => !o && !busy && onClose()}
      title={t("studyExport.title")}
      description={study ? t("studyExport.hint", { name: study.name }) : undefined}
      width={640}
      dismissable={!busy}
      footer={
        <>
          <span className="mr-auto text-xs text-muted">{t("studyExport.count", { n: selected.length, total: projects.length })}</span>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" icon={<FolderDown className="size-4" />} loading={busy} disabled={selected.length === 0} onClick={() => void run()}>
            {t("studyExport.choose")}
          </Button>
        </>
      }
    >
      {busy ? (
        <div className="flex flex-col gap-2 py-6">
          <span className="text-sm">{t("studyExport.working", { n: progress.done, total: progress.total })}</span>
          <Progress value={progress.total ? progress.done / progress.total : null} />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <FormatPicker value={format} onChange={setFormat} only={["docx", "maxqda", "nvivo", "txt", "md", "json"]} />
          <FormatOptions
            format={format}
            timestamps={timestamps}
            onTimestamps={setTimestamps}
            numbering={numbering}
            onNumbering={setNumbering}
            clean={clean}
            onClean={setClean}
            anonymize={{ rules: study?.pseudonyms.length ?? 0, value: anonymize, onChange: setAnonymize }}
            notation={notation}
            onNotation={setNotation}
          />
          <div className="flex flex-col gap-3 rounded-xl border border-line px-3.5 py-3">
            <Toggle label={t("studyExport.qdpx")} hint={t("studyExport.qdpxHint")} checked={qdpx} onChange={setQdpx} />
            <Toggle label={t("studyExport.csv")} checked={csv} onChange={setCsv} />
            <Toggle label={t("studyExport.originals")} hint={t("studyExport.originalsHint")} checked={originals} onChange={setOriginals} />
            <Toggle label={t("studyExport.onlyChecked")} checked={onlyChecked} onChange={setOnlyChecked} />
          </div>
          {ready.length === 0 && <p className="text-[13px] text-muted">{t("studyExport.none")}</p>}
        </div>
      )}
    </Dialog>
  );
}

/**
 * The pseudonym key: which real name or detail became which placeholder, and how often, per
 * interview. It identifies participants, so it is saved on its own, never with the export.
 */
export async function exportPseudonymKey(study: Study, projects: Project[], uiLanguage: "nl" | "en"): Promise<void> {
  const { pickSavePath } = await import("@/lib/platform");
  const { toast } = useApp.getState();
  const t = (k: "nl" | "en") => (k === "nl" ? ["Origineel", "Vervanging", "Geldt voor", "Aantal"] : ["Original", "Replacement", "Applies to", "Count"]);
  const sep = uiLanguage === "nl" ? ";" : ",";
  const cell = (v: string) => (/[",;\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows: string[][] = [t(uiLanguage)];
  const studyCounts = study.pseudonyms.map(() => 0);
  for (const p of projects.filter((x) => x.status === "ready")) {
    const [transcript, extras] = await Promise.all([api.loadTranscript(p.id), api.loadExtras(p.id)]);
    const own = (extras.anonymize ?? []).filter((r) => r.find.trim());
    const ownCounts = anonymizeTranscript(transcript, own).counts;
    own.forEach((r, i) => rows.push([r.find, r.replace, p.name, String(ownCounts[i])]));
    anonymizeTranscript(transcript, study.pseudonyms).counts.forEach((n, i) => (studyCounts[i] += n));
  }
  study.pseudonyms.forEach((r, i) => rows.splice(1 + i, 0, [r.find, r.replace, study.name, String(studyCounts[i])]));
  const path = await pickSavePath(`${study.name} - ${uiLanguage === "nl" ? "pseudoniemensleutel" : "pseudonym key"}.csv`, "csv");
  if (!path) return;
  await api.writeFile(path, new TextEncoder().encode("\ufeff" + rows.map((r) => r.map(cell).join(sep)).join("\r\n") + "\r\n"));
  toast(translate(uiLanguage, "studyExport.keySaved"), "ok");
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-4 text-sm">
      <span>
        {label}
        {hint && <span className="block text-xs leading-snug text-muted">{hint}</span>}
      </span>
      <Switch checked={checked} onChange={onChange} label={label} />
    </label>
  );
}
