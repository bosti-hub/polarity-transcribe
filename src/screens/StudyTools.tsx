// Study-wide tools in the library: all saved quotes, search across every transcript, and a
// generated methods paragraph.

import { Copy, Download, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Dialog, Segmented, Spinner, Switch } from "@/components/ui";
import type { QuoteExportItem } from "@/components/QuoteExport";
import { anonymizeText, mergeRules, pseudonymSpans, wholeWord } from "@/lib/anonymize";
import { api, errorMessage } from "@/lib/api";
import { translate, useT } from "@/lib/i18n";
import { interviewDate, participantCodes, recordingOffset } from "@/lib/interviews";
import { useApp } from "@/lib/store";
import { MOD, shortcutLabel } from "@/lib/keys";
import { methodsText, type MethodsFacts } from "@/lib/methods";
import { formatClock, itemText, speakerName } from "@/lib/transcript";
import type { Language, Project, ProjectExtras, Study, Transcript } from "@/lib/types";

const fail = (e: unknown) => useApp.getState().toast(errorMessage(e), "error");

/** Transcripts and extras of the transcribed interviews, loaded once per view. */
export function useStudyData(projects: Project[], need: { transcripts?: boolean; extras?: boolean }) {
  const ready = useMemo(() => projects.filter((p) => p.status === "ready"), [projects]);
  const key = ready.map((p) => `${p.id}:${p.updatedAt}`).join();
  const [data, setData] = useState<{ project: Project; transcript?: Transcript; extras?: ProjectExtras }[] | null>(null);
  useEffect(() => {
    let alive = true;
    setData(null);
    Promise.all(
      ready.map(async (project) => ({
        project,
        transcript: need.transcripts ? await api.loadTranscript(project.id) : undefined,
        extras: need.extras ? await api.loadExtras(project.id) : undefined,
      })),
    ).then((d) => alive && setData(d), fail);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, need.transcripts, need.extras]);
  return data;
}

function openAt(projectId: string, at: number) {
  useApp.getState().go({ name: "editor", id: projectId, at });
}

// ------------------------------------------------------------------ quotes

/** All quotes of a study, sorted by participant, date and time; pseudonymised or not. */
export function studyQuoteItems(data: { project: Project; transcript?: Transcript; extras?: ProjectExtras }[], study: Study, pseudo: boolean): QuoteExportItem[] {
  const out: (QuoteExportItem & { date: number })[] = [];
  for (const { project, transcript, extras } of data) {
    const all = mergeRules(extras?.anonymize ?? [], study.pseudonyms);
    const rules = pseudo ? all : [];
    for (const q of extras?.quotes ?? []) {
      out.push({
        projectId: project.id,
        s: q.s,
        e: q.e,
        // Without the transcript (the study's quote list), nothing to beep.
        spans: transcript ? pseudonymSpans(transcript, all, q.s - 2, q.e + 2) : [],
        date: interviewDate(project).getTime(),
        line: {
          text: anonymizeText(q.text, rules),
          participant: participantCodes(project, study),
          interview: anonymizeText(project.name, rules),
          time: formatClock(q.s + recordingOffset(project)),
          note: anonymizeText(q.note, rules),
        },
      });
    }
  }
  return out.sort((a, b) => a.line.participant.localeCompare(b.line.participant) || a.date - b.date || a.s - b.s);
}

export function StudyQuotes({ study, projects, onExport }: { study: Study; projects: Project[]; onExport: () => void }) {
  const t = useT();
  const data = useStudyData(projects, { extras: true });
  const [pseudonymise, setPseudonymise] = useState(true);

  const build = useCallback((pseudo: boolean) => (data ? studyQuoteItems(data, study, pseudo) : []), [data, study]);
  const lines = useMemo(() => (data ? build(pseudonymise) : null), [data, build, pseudonymise]);

  if (!lines) return <Loading />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 text-[13px] text-fg-2">{t("quotes.studyHint")}</p>
        {study.pseudonyms.length > 0 && (
          <label className="flex items-center gap-2 text-[13px]">
            {t("export.anonymize")}
            <Switch checked={pseudonymise} onChange={setPseudonymise} label={t("export.anonymize")} />
          </label>
        )}
        <Button size="sm" variant="secondary" icon={<Download className="size-3.5" />} disabled={!lines.length} onClick={onExport}>
          {t("quotes.export")}
        </Button>
      </div>
      {lines.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line-strong bg-surface px-6 py-10 text-center text-[13px] text-fg-2">{t("quotes.studyEmpty", { key: shortcutLabel(`${MOD}+U`) })}</p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
          {lines.map(({ projectId, s: at, line: q }, i) => (
            <li key={i}>
              <button onClick={() => openAt(projectId, at)} className="w-full px-4 py-3 text-left hover:bg-surface-2">
                <p className="text-[13px] leading-relaxed italic">“{q.text}”</p>
                <p className="mt-1 text-xs text-muted">{[q.participant, q.interview, q.time].filter(Boolean).join(" · ")}</p>
                {q.note && <p className="mt-1 text-xs text-fg-2">{q.note}</p>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ search

interface Hit {
  projectId: string;
  interview: string;
  participant: string;
  speaker: string;
  at: number;
  time: string;
  before: string;
  match: string;
  after: string;
}

const MAX_HITS = 500;

export function StudySearch({ study, projects }: { study: Study; projects: Project[] }) {
  const t = useT();
  const data = useStudyData(projects, { transcripts: true });
  const [query, setQuery] = useState("");
  const [whole, setWhole] = useState(false);
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  const hits = useMemo(() => {
    const q = debounced.trim();
    if (!data || q.length < 2) return null;
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = whole ? wholeWord(q)! : new RegExp(escaped, "giu");
    const out: Hit[] = [];
    for (const { project, transcript } of data) {
      if (!transcript) continue;
      for (const p of transcript.paragraphs) {
        // The turn's text, and where each item starts in it (for the time of a hit).
        let text = "";
        const starts: { at: number; s: number }[] = [];
        for (const it of p.items) {
          if (text) text += " ";
          starts.push({ at: text.length, s: "s" in it && typeof it.s === "number" ? it.s : p.start });
          text += itemText(it, transcript);
        }
        for (const m of text.matchAll(re)) {
          const item = [...starts].reverse().find((x) => x.at <= m.index) ?? starts[0];
          out.push({
            projectId: project.id,
            interview: project.name,
            participant: participantCodes(project, study),
            speaker: speakerName(transcript, p.speaker),
            at: item?.s ?? p.start,
            time: formatClock((item?.s ?? p.start) + recordingOffset(project)),
            before: text.slice(Math.max(0, m.index - 70), m.index),
            match: m[0],
            after: text.slice(m.index + m[0].length, m.index + m[0].length + 70),
          });
          if (out.length >= MAX_HITS) return out;
        }
      }
    }
    return out;
  }, [data, debounced, whole, study]);

  const interviews = new Set(hits?.map((h) => h.projectId)).size;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("studySearch.placeholder")}
            aria-label={t("studySearch.placeholder")}
            className="h-9 w-full rounded-lg border border-line-strong bg-surface pr-3 pl-9 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </div>
        <label className="flex items-center gap-1.5 text-[13px] text-fg-2">
          <input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} className="accent-[var(--accent)]" />
          {t("editor.wholeWord")}
        </label>
      </div>
      {!data ? (
        <Loading />
      ) : hits === null ? (
        <p className="text-[13px] text-muted">{t("studySearch.hint", { n: data.length })}</p>
      ) : hits.length === 0 ? (
        <p className="text-[13px] text-muted">{t("editor.noHits")}</p>
      ) : (
        <>
          <p className="text-xs text-muted">{t("studySearch.count", { n: hits.length >= MAX_HITS ? `${MAX_HITS}+` : hits.length, m: interviews })}</p>
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
            {hits.map((h, i) => (
              <li key={i}>
                <button onClick={() => openAt(h.projectId, h.at)} className="w-full px-4 py-2.5 text-left hover:bg-surface-2">
                  <p className="text-xs text-muted">{[h.participant, h.interview, h.speaker, h.time].filter(Boolean).join(" · ")}</p>
                  <p className="mt-0.5 text-[13px] leading-relaxed">
                    {h.before.length >= 70 && "…"}
                    {h.before}
                    <mark className="rounded bg-warn-soft px-0.5 text-fg">{h.match}</mark>
                    {h.after}
                    {h.after.length >= 70 && "…"}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Loading() {
  return (
    <div className="flex justify-center py-16">
      <Spinner className="size-5" />
    </div>
  );
}

// ------------------------------------------------------------------ methods paragraph

export function MethodsDialog({ study, projects, onClose }: { study: Study | null; projects: Project[]; onClose: () => void }) {
  const t = useT();
  const uiLanguage = useApp((s) => s.settings.uiLanguage);
  const version = useApp((s) => s.info?.version ?? "");
  const [lang, setLang] = useState<Language>(study?.language ?? uiLanguage);
  const [facts, setFacts] = useState<MethodsFacts | null>(null);
  const [text, setText] = useState("");

  useEffect(() => {
    if (!study) return;
    setLang(study.language);
    let alive = true;
    const ready = projects.filter((p) => p.status === "ready");
    Promise.all(ready.map((p) => api.loadReport(p.id).catch(() => null))).then((reports) => {
      if (!alive) return;
      const uniq = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];
      setFacts({
        n: ready.length,
        seconds: ready.reduce((sum, p) => sum + p.duration, 0),
        checked: ready.filter((p) => p.review !== "todo").length,
        version,
        models: uniq(reports.map((r) => r?.model as string | undefined)),
        methods: uniq(reports.map((r) => r?.method as string | undefined)),
        pause: study.pauseThreshold,
        pseudonyms: study.pseudonyms.length > 0,
      });
    }, fail);
    return () => {
      alive = false;
    };
  }, [study, projects, version]);

  useEffect(() => {
    if (facts) setText(methodsText(facts, lang));
  }, [facts, lang]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      useApp.getState().toast(translate(uiLanguage, "methods.copied"), "ok");
    } catch (e) {
      fail(e);
    }
  };

  return (
    <Dialog
      open={study !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("methods.title")}
      description={t("methods.hint")}
      width={640}
      footer={
        <>
          <div className="mr-auto">
            <Segmented<Language>
              size="sm"
              value={lang}
              onChange={setLang}
              options={[
                { value: "nl", label: t("common.dutch") },
                { value: "en", label: t("common.english") },
              ]}
            />
          </div>
          <Button variant="ghost" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button variant="primary" icon={<Copy className="size-4" />} disabled={!text} onClick={() => void copy()}>
            {t("methods.copy")}
          </Button>
        </>
      }
    >
      {facts ? (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={11}
          className="w-full resize-y rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm leading-relaxed outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
      ) : (
        <Loading />
      )}
    </Dialog>
  );
}
