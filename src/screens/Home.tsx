// The library: a sidebar with all interviews and the studies, and the interviews (or the
// participants) of what is selected. Drop recordings anywhere to add interviews.

import {
  AlertTriangle,
  AudioLines,
  Download,
  FileArchive,
  FileAudio,
  FileVideo,
  FolderOpen,
  FolderInput,
  KeyRound,
  ScrollText,
  Layers,
  MessagesSquare,
  Mic,
  CircleHelp,
  MoreHorizontal,
  Pencil,
  Plus,
  Presentation,
  Search,
  Settings as SettingsIcon,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Frame, OfflineBadge } from "@/components/Frame";
import { UpdateBanner } from "@/components/UpdateBanner";
import { Badge, Button, Callout, cx, Dialog, IconButton, Menu, MenuItem, MenuSeparator, Progress, Select, Spinner, TextInput } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useT } from "@/lib/i18n";
import type { TFn } from "@/lib/i18n";
import { canQueue, interviewDate, participantCodes, STAGE_GROUPS, STAGE_STYLE, stageOf, type Stage } from "@/lib/interviews";
import { onFileDrop, pickAudioFiles } from "@/lib/platform";
import { exportShare, importShare } from "@/lib/share";
import { activeModel, useApp } from "@/lib/store";
import { formatDuration } from "@/lib/transcript";
import type { Language, Project, ProjectPatch, Study } from "@/lib/types";
import { ParticipantsTable } from "./Participants";
import { DeleteStudyDialog, NewStudyDialog, StudySettingsDialog } from "./StudyDialogs";
import { exportPseudonymKey, StudyExportDialog } from "./StudyExport";
import type { ExportTab } from "@/editor/ExportDialog";
import { MethodsDialog, StudyQuotes, StudySearch } from "./StudyTools";

const TAB_LABELS = {
  interviews: "library.tabInterviews",
  participants: "library.tabParticipants",
  quotes: "library.tabQuotes",
  search: "library.tabSearch",
} as const;

const fail = (e: unknown) => useApp.getState().toast(errorMessage(e), "error");
const locale = (lang: Language) => (lang === "nl" ? "nl-NL" : "en-GB");

function shortDay(d: Date, lang: Language): string {
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(locale(lang), { day: "numeric", month: "short", year: sameYear ? undefined : "numeric" }).format(d);
}

/** The interview language chosen last time: people usually transcribe a series in one language. */
function lastInterviewLanguage(): Language | null {
  try {
    const v = localStorage.getItem("pt.interviewLanguage");
    return v === "nl" || v === "en" ? v : null;
  } catch {
    return null;
  }
}

/**
 * What a new recording is: a conversation (speakers told apart by voice or microphone) or a
 * lecture or presentation (one speaker, so voices are not told apart).
 */
type RecordingKind = "conversation" | "lecture";
const KIND_KEY = "pt.recordingKind";

/** A lecture or presentation: one speaker, and a clean reading text without fillers or pauses. */
const LECTURE: ProjectPatch = { speakerCount: 1, verbatim: false };

/** The kind chosen last time in the import dialog. */
function lastKind(): RecordingKind {
  try {
    return localStorage.getItem(KIND_KEY) === "lecture" ? "lecture" : "conversation";
  } catch {
    return "conversation";
  }
}

function rememberKind(kind: RecordingKind) {
  try {
    localStorage.setItem(KIND_KEY, kind);
  } catch {
    // Not remembered; the dialog starts with "conversation" next time.
  }
}

/** An interview name from a recording's file name. */
function nameFromFile(path: string, t: TFn, lang: Language): string {
  const fromFile = (path.split(/[\\/]/).pop() ?? "").replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim();
  const date = new Intl.DateTimeFormat(locale(lang), { day: "numeric", month: "short", year: "numeric" }).format(new Date());
  return fromFile || t("home.defaultName", { date });
}

/**
 * One interview from one or two recordings of the same conversation; opens its setup.
 * `setup` overrides the defaults (a lecture: one speaker, no fillers or pause tags).
 */
async function startInterview(paths: string[], studyId: string | null, t: TFn, setup?: ProjectPatch) {
  const { settings, queueImports, go, refreshStudies } = useApp.getState();
  let project = await api.createProject(nameFromFile(paths[0], t, settings.uiLanguage), lastInterviewLanguage() ?? settings.uiLanguage, studyId);
  if (setup) project = await api.updateProject(project.id, setup);
  if (studyId) void refreshStudies();
  queueImports(project.id, paths.slice(0, 2));
  go({ name: "setup", id: project.id });
}

/** One interview per recording, imported one after another in the background. */
async function addInterviews(paths: string[], studyId: string | null, t: TFn, setup?: ProjectPatch) {
  const { settings, importInBackground, refreshStudies, toast } = useApp.getState();
  const jobs: { projectId: string; path: string }[] = [];
  for (const path of paths) {
    const p = await api.createProject(nameFromFile(path, t, settings.uiLanguage), lastInterviewLanguage() ?? settings.uiLanguage, studyId);
    if (setup) await api.updateProject(p.id, setup);
    jobs.push({ projectId: p.id, path });
  }
  importInBackground(jobs);
  if (studyId) void refreshStudies();
  toast(t("library.batchAdded", { n: paths.length }), "ok");
}

function useProjects() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const load = useCallback(() => {
    api
      .listProjects()
      .then((list) => setProjects([...list].sort((a, b) => b.updatedAt - a.updatedAt)))
      .catch(fail);
  }, []);
  // Reload when something finishes: a job, the queue or a background import.
  const jobKey = useApp((s) => Object.values(s.jobs).map((j) => `${j.projectId}:${j.state}`).join());
  const queueKey = useApp((s) => s.queue.join());
  const importKey = useApp((s) => Object.keys(s.importing).join());
  const processing = projects?.some((p) => p.status === "processing") ?? false;

  useEffect(() => {
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);
  useEffect(load, [load, jobKey, queueKey, importKey]);
  useEffect(() => {
    if (!processing) return;
    const timer = window.setInterval(load, 4000);
    return () => window.clearInterval(timer);
  }, [processing, load]);

  return { projects, reload: load };
}

function useStage() {
  const jobs = useApp((s) => s.jobs);
  const queue = useApp((s) => s.queue);
  const importing = useApp((s) => s.importing);
  return useCallback((p: Project): Stage => stageOf(p, jobs[p.id], queue.includes(p.id), p.id in importing), [jobs, queue, importing]);
}

// ------------------------------------------------------------------ screen

export function Home() {
  const t = useT();
  const go = useApp((s) => s.go);
  const info = useApp((s) => s.info);
  const library = useApp((s) => s.library);
  const studies = useApp((s) => s.studies);
  const showLibrary = useApp((s) => s.showLibrary);
  const hasModel = useApp((s) => activeModel(s.models, s.settings) !== null);
  const { projects, reload } = useProjects();
  const stageFor = useStage();

  const study = studies.find((s) => s.id === library);
  const studyId = study?.id ?? null;
  const [tab, setTab] = useState<"interviews" | "participants" | "quotes" | "search">("interviews");
  const [methodsOf, setMethodsOf] = useState<Study | null>(null);
  const [dragging, setDragging] = useState(false);
  const [twoFiles, setTwoFiles] = useState<string[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [kind, setKind] = useState<RecordingKind>(lastKind);
  const [newStudy, setNewStudy] = useState(false);
  const [settingsOf, setSettingsOf] = useState<Study | null>(null);
  const [deletingStudy, setDeletingStudy] = useState<Study | null>(null);
  const [exportingStudy, setExportingStudy] = useState<Study | null>(null);
  const [exportTab, setExportTab] = useState<ExportTab>("transcript");

  useEffect(() => setTab("interviews"), [library]);

  const handleFiles = useCallback(
    async (paths: string[], as: RecordingKind = "conversation") => {
      if (paths.length === 0) return;
      try {
        // A lecture is one speaker per recording: several files are separate transcriptions.
        if (as === "lecture") {
          if (paths.length === 1) await startInterview(paths, studyId, t, LECTURE);
          else await addInterviews(paths, studyId, t, LECTURE);
        } else if (paths.length === 1) await startInterview(paths, studyId, t);
        else if (paths.length === 2) setTwoFiles(paths);
        else await addInterviews(paths, studyId, t);
      } catch (e) {
        fail(e);
      }
    },
    [studyId, t],
  );

  /** ZIP files shared by a colleague, one after another; no paths = pick one. */
  const importArchives = useCallback(
    async (paths: string[] = []) => {
      const lang = useApp.getState().settings.uiLanguage;
      if (paths.length === 0) {
        if (await importShare(t, lang)) reload();
        return;
      }
      for (const path of paths) await importShare(t, lang, path);
      reload();
    },
    [t, reload],
  );

  // Files dropped while the import dialog is open are of the kind chosen there; dropped anywhere
  // else on the start screen they are a conversation, as before.
  const dropKind = useRef<RecordingKind | null>(null);
  dropKind.current = importing ? kind : null;
  const importFiles = useCallback(
    (paths: string[], as: RecordingKind) => {
      rememberKind(as);
      setImporting(false);
      void handleFiles(paths, as);
    },
    [handleFiles],
  );
  useEffect(
    () =>
      onFileDrop({
        onHover: setDragging,
        onDrop: (paths) => (dropKind.current ? importFiles(paths, dropKind.current) : void handleFiles(paths)),
        onArchives: (paths) => {
          setImporting(false);
          void importArchives(paths);
        },
      }),
    [handleFiles, importFiles, importArchives],
  );

  const create = () => setImporting(true);

  const inView = useMemo(() => (projects ?? []).filter((p) => !study || p.studyId === study.id), [projects, study]);
  const queueable = inView.filter((p) => canQueue(p, stageFor(p)));

  const transcribeAll = async () => {
    try {
      // Oldest first: the order in which they were added.
      const ids = [...queueable].sort((a, b) => a.createdAt - b.createdAt).map((p) => p.id);
      await api.queueJobs(ids);
      useApp.getState().toast(t("library.queuedToast", { n: ids.length }), "ok");
      reload();
    } catch (e) {
      fail(e);
    }
  };

  const counts = useMemo(() => {
    const all = projects ?? [];
    const out: Record<string, number> = { all: all.length };
    for (const p of all) if (p.studyId) out[p.studyId] = (out[p.studyId] ?? 0) + 1;
    return out;
  }, [projects]);

  const newButton = (
    <Button variant="primary" icon={<Plus className="size-4" />} onClick={create}>
      {study ? t("library.newInterview") : t("home.new")}
    </Button>
  );

  return (
    <Frame
      title={study?.name ?? t("library.all")}
      subtitle={projects ? t("library.count", { n: inView.length }) : undefined}
      actions={
        <>
          <OfflineBadge />
          {study && (
            <>
              <IconButton
                label={t("studyExport.title")}
                onClick={() => {
                  setExportTab("transcript");
                  setExportingStudy(study);
                }}
              >
                <Download className="size-[18px]" />
              </IconButton>
              <IconButton label={t("library.studySettings")} onClick={() => setSettingsOf(study)}>
                <SlidersHorizontal className="size-[18px]" />
              </IconButton>
            </>
          )}
          <IconButton label={t("help.title")} onClick={() => go({ name: "help" })}>
            <CircleHelp className="size-[18px]" />
          </IconButton>
          <IconButton label={t("common.settings")} onClick={() => go({ name: "settings" })}>
            <SettingsIcon className="size-[18px]" />
          </IconButton>
          <div className="ml-1">{newButton}</div>
        </>
      }
      bodyClassName="flex min-h-0 flex-1"
    >
      <Sidebar
        studies={studies}
        counts={counts}
        selected={library}
        onSelect={showLibrary}
        onNewStudy={() => setNewStudy(true)}
        onSettings={setSettingsOf}
        onExport={(s) => {
          setExportTab("transcript");
          setExportingStudy(s);
        }}
        onMethods={setMethodsOf}
        onShare={(s) => void exportShare(t, { study: s, inStudy: counts[s.id] ?? 0 })}
        onImport={() => void importArchives()}
        onExportKey={(s) => {
          const lang = useApp.getState().settings.uiLanguage;
          void exportPseudonymKey(s, (projects ?? []).filter((p) => p.studyId === s.id), lang).catch(fail);
        }}
        onDelete={setDeletingStudy}
      />

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[960px] flex-col gap-4 px-6 pt-6 pb-16">
          <UpdateBanner />
          {info?.cpuSupported === false && (
            <Callout tone="danger" icon={<AlertTriangle />}>
              {t("models.cpuUnsupported")}
            </Callout>
          )}
          {!hasModel && (
            <Callout tone="accent" icon={<Sparkles />}>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className="flex-1 font-medium">{t("setup.needModel")}</span>
                <Button size="sm" variant="soft" onClick={() => go({ name: "settings" })}>
                  {t("home.needModelAction")}
                </Button>
              </div>
            </Callout>
          )}

          {(study || queueable.length > 0) && (
            <div className="flex flex-wrap items-center gap-3">
              {study && (
                <div className="inline-flex rounded-lg bg-surface-3 p-0.5" role="tablist">
                  {(["interviews", "participants", "quotes", "search"] as const).map((id) => (
                    <button
                      key={id}
                      role="tab"
                      aria-selected={tab === id}
                      onClick={() => setTab(id)}
                      className={cx(
                        "h-8 rounded-md px-3 text-sm font-medium transition-colors",
                        tab === id ? "bg-surface text-fg shadow-card" : "text-fg-2 hover:text-fg",
                      )}
                    >
                      {t(TAB_LABELS[id])}
                      {(id === "interviews" || id === "participants") && (
                        <span className="ml-1.5 text-xs text-muted tabular-nums">
                          {id === "interviews" ? inView.length : study.participants.length}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex-1" />
              {tab === "interviews" && queueable.length > 0 && hasModel && (
                <Button variant="soft" icon={<AudioLines className="size-4" />} onClick={() => void transcribeAll()}>
                  {t("library.transcribeAll", { n: queueable.length })}
                </Button>
              )}
            </div>
          )}

          {projects === null ? (
            <div className="flex justify-center py-24">
              <Spinner className="size-5" />
            </div>
          ) : study && tab === "participants" ? (
            <ParticipantsTable study={study} projects={inView} />
          ) : study && tab === "quotes" ? (
            <StudyQuotes
              study={study}
              projects={inView}
              onExport={() => {
                setExportTab("quotes");
                setExportingStudy(study);
              }}
            />
          ) : study && tab === "search" ? (
            <StudySearch study={study} projects={inView} />
          ) : inView.length === 0 ? (
            <EmptyState study={study} action={newButton} />
          ) : (
            <InterviewList projects={inView} study={study} studies={studies} stageFor={stageFor} onChanged={reload} />
          )}
        </div>
      </div>

      <ImportDialog
        open={importing}
        title={study ? t("library.newInterview") : t("home.new")}
        kind={kind}
        onKind={setKind}
        onClose={() => setImporting(false)}
        onFiles={(paths) => importFiles(paths, kind)}
        onArchive={() => {
          setImporting(false);
          void importArchives();
        }}
      />
      <TwoFilesDialog
        paths={twoFiles}
        onClose={() => setTwoFiles(null)}
        onSame={(paths) => void startInterview(paths, studyId, t).catch(fail)}
        onSeparate={(paths) => void addInterviews(paths, studyId, t).catch(fail)}
      />
      <NewStudyDialog open={newStudy} onClose={() => setNewStudy(false)} />
      <StudySettingsDialog study={settingsOf} onClose={() => setSettingsOf(null)} onDelete={(s) => setDeletingStudy(s)} />
      <MethodsDialog study={methodsOf} projects={(projects ?? []).filter((p) => p.studyId === methodsOf?.id)} onClose={() => setMethodsOf(null)} />
      <StudyExportDialog
        study={exportingStudy}
        projects={(projects ?? []).filter((p) => p.studyId === exportingStudy?.id)}
        onClose={() => setExportingStudy(null)}
        tab={exportTab}
        onTab={setExportTab}
      />
      <DeleteStudyDialog study={deletingStudy} interviews={deletingStudy ? (counts[deletingStudy.id] ?? 0) : 0} onClose={() => setDeletingStudy(null)} onDone={reload} />

      {dragging && (
        <div className="anim-fade pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-bg/80 p-6 backdrop-blur-sm">
          <div className="flex h-full w-full flex-col items-center justify-center gap-4 rounded-3xl border-2 border-dashed border-accent bg-accent-soft/60">
            <span className="flex size-16 items-center justify-center rounded-2xl bg-accent text-accent-fg shadow-pop">
              <Upload className="size-7" />
            </span>
            <span className="text-lg font-semibold tracking-tight text-accent">{t("home.drop")}</span>
            {study && <span className="text-sm text-fg-2">{study.name}</span>}
          </div>
        </div>
      )}
    </Frame>
  );
}

// ------------------------------------------------------------------ sidebar

function Sidebar({
  studies,
  counts,
  selected,
  onSelect,
  onNewStudy,
  onSettings,
  onExport,
  onExportKey,
  onMethods,
  onShare,
  onImport,
  onDelete,
}: {
  studies: Study[];
  counts: Record<string, number>;
  selected: string;
  onSelect: (id: string) => void;
  onNewStudy: () => void;
  onSettings: (s: Study) => void;
  onExport: (s: Study) => void;
  onExportKey: (s: Study) => void;
  onMethods: (s: Study) => void;
  onShare: (s: Study) => void;
  onImport: () => void;
  onDelete: (s: Study) => void;
}) {
  const t = useT();
  const item = (active: boolean) =>
    cx(
      "group flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm transition-colors",
      active ? "bg-surface font-medium text-fg shadow-card" : "text-fg-2 hover:bg-surface-3 hover:text-fg",
    );
  return (
    <nav className="flex w-60 shrink-0 flex-col gap-1 overflow-y-auto border-r border-line bg-bg p-3" aria-label={t("library.studies")}>
      <button className={item(selected === "all")} onClick={() => onSelect("all")} aria-current={selected === "all"}>
        <Layers className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t("library.all")}</span>
        <span className="text-xs text-muted tabular-nums">{counts.all ?? 0}</span>
      </button>

      <div className="mt-4 mb-1 flex items-center justify-between pr-1 pl-2.5">
        <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">{t("library.studies")}</span>
        <IconButton label={t("library.newStudy")} size="sm" onClick={onNewStudy}>
          <Plus className="size-4" />
        </IconButton>
      </div>
      {studies.map((s) => (
        <div key={s.id} className="group relative">
          <button className={item(selected === s.id)} onClick={() => onSelect(s.id)} aria-current={selected === s.id}>
            <FolderOpen className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            <span className="text-xs text-muted tabular-nums group-hover:opacity-0">{counts[s.id] ?? 0}</span>
          </button>
          <div className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-hover:opacity-100 has-[[data-state=open]]:opacity-100">
            <Menu
              trigger={
                <IconButton label={t("home.more")} size="sm">
                  <MoreHorizontal className="size-4" />
                </IconButton>
              }
            >
              <MenuItem icon={<SlidersHorizontal />} onSelect={() => onSettings(s)}>
                {t("library.studySettings")}
              </MenuItem>
              <MenuItem icon={<Download />} onSelect={() => onExport(s)}>
                {t("studyExport.title")}
              </MenuItem>
              <MenuItem icon={<Share2 />} onSelect={() => onShare(s)}>
                {t("share.export")}
              </MenuItem>
              <MenuItem icon={<KeyRound />} onSelect={() => onExportKey(s)}>
                {t("studyExport.keyTitle")}
              </MenuItem>
              <MenuItem icon={<ScrollText />} onSelect={() => onMethods(s)}>
                {t("methods.title")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem danger icon={<Trash2 />} onSelect={() => onDelete(s)}>
                {t("study.delete")}
              </MenuItem>
            </Menu>
          </div>
        </div>
      ))}
      {studies.length === 0 && (
        <button onClick={onNewStudy} className="rounded-lg border border-dashed border-line-strong px-3 py-3 text-left text-xs leading-relaxed text-fg-2 hover:border-accent hover:text-accent">
          <span className="mb-0.5 flex items-center gap-1.5 font-medium">
            <Plus className="size-3.5" />
            {t("library.newStudy")}
          </span>
          {t("study.createHint")}
        </button>
      )}
      <div className="flex-1" />
      <button className={cx(item(false), "mt-4 text-[13px]")} onClick={onImport} title={t("share.importHint")}>
        <FileArchive className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t("share.import")}</span>
      </button>
    </nav>
  );
}

// ------------------------------------------------------------------ interview list

function InterviewList({
  projects,
  study,
  studies,
  stageFor,
  onChanged,
}: {
  projects: Project[];
  study: Study | undefined;
  studies: Study[];
  stageFor: (p: Project) => Stage;
  onChanged: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("all");
  const [tag, setTag] = useState("");
  const [renaming, setRenaming] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [moving, setMoving] = useState<Project | null>(null);

  const groupCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const p of projects) {
      const g = STAGE_GROUPS.find((x) => x.stages.includes(stageFor(p)));
      if (g) out[g.id] = (out[g.id] ?? 0) + 1;
    }
    return out;
  }, [projects, stageFor]);
  const allTags = useMemo(() => [...new Set(projects.flatMap((p) => p.tags))].sort((a, b) => a.localeCompare(b)), [projects]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const stages = STAGE_GROUPS.find((g) => g.id === group)?.stages;
    return projects.filter((p) => {
      if (stages && !stages.includes(stageFor(p))) return false;
      if (tag && !p.tags.includes(tag)) return false;
      if (!q) return true;
      const st = studies.find((s) => s.id === p.studyId);
      const hay = [p.name, p.interviewer, participantCodes(p, st), ...p.tags, ...p.sources.map((s) => s?.fileName ?? "")];
      return hay.some((x) => x.toLowerCase().includes(q));
    });
  }, [projects, query, group, tag, stageFor, studies]);

  const showFilters = projects.length > 3;

  return (
    <>
      {showFilters && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1.5">
            <FilterChip active={group === "all"} onClick={() => setGroup("all")} label={t("library.filterAll")} count={projects.length} />
            {STAGE_GROUPS.filter((g) => groupCounts[g.id]).map((g) => (
              <FilterChip key={g.id} active={group === g.id} onClick={() => setGroup(g.id)} label={t(g.label)} count={groupCounts[g.id]} />
            ))}
          </div>
          <div className="flex-1" />
          {allTags.length > 0 && (
            <Select value={tag} onChange={(e) => setTag(e.target.value)} aria-label={t("library.tags")} className="h-8 text-[13px]">
              <option value="">{t("library.tags")}: {t("library.filterAll").toLowerCase()}</option>
              {allTags.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
          )}
          <div className="relative w-52">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
            <TextInput type="search" aria-label={t("home.search")} placeholder={t("home.search")} value={query} onChange={(e) => setQuery(e.target.value)} className="h-8 pl-9" />
          </div>
        </div>
      )}
      <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
        {visible.map((p) => (
          <InterviewRow
            key={p.id}
            project={p}
            stage={stageFor(p)}
            study={studies.find((s) => s.id === p.studyId)}
            showStudy={!study}
            onRename={() => setRenaming(p)}
            onMove={() => setMoving(p)}
            onDelete={() => setDeleting(p)}
          />
        ))}
      </ul>
      <RenameDialog project={renaming} onClose={() => setRenaming(null)} onDone={onChanged} />
      <DeleteDialog project={deleting} onClose={() => setDeleting(null)} onDone={onChanged} />
      <MoveDialog project={moving} studies={studies} onClose={() => setMoving(null)} onDone={onChanged} />
    </>
  );
}

function FilterChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
        active ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface text-fg-2 hover:border-line-strong hover:text-fg",
      )}
    >
      {label}
      <span className="tabular-nums opacity-70">{count}</span>
    </button>
  );
}

function openRoute(p: Project) {
  const { go } = useApp.getState();
  if (p.status === "processing") go({ name: "progress", id: p.id });
  else if (p.status === "ready") go({ name: "editor", id: p.id });
  else go({ name: "setup", id: p.id });
}

function StageBadge({ stage, pct }: { stage: Stage; pct?: number }) {
  const t = useT();
  const style = STAGE_STYLE[stage];
  return <Badge tone={style.tone}>{t(style.label, { pct: Math.round((pct ?? 0) * 100) })}</Badge>;
}

function InterviewRow({
  project,
  stage,
  study,
  showStudy,
  onRename,
  onMove,
  onDelete,
}: {
  project: Project;
  stage: Stage;
  study: Study | undefined;
  showStudy: boolean;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const lang = useApp((s) => s.settings.uiLanguage);
  const job = useApp((s) => s.jobs[project.id]);
  const importPct = useApp((s) => s.importing[project.id]);
  const sources = project.sources.filter((s) => s !== null);
  const files = sources.map((s) => s.fileName).join(" + ");
  const seconds = project.status === "ready" ? project.duration : (sources[0]?.duration ?? 0);
  const codes = participantCodes(project, study);
  const running = stage === "processing" && job?.state === "running";

  return (
    <li className="group relative flex items-center transition-colors hover:bg-surface-2">
      <button
        type="button"
        onClick={() => openRoute(project)}
        disabled={stage === "importing"}
        className="flex min-w-0 flex-1 items-center gap-3.5 py-3 pr-2 pl-4 text-left outline-none focus-visible:bg-surface-2"
      >
        <span
          className={cx(
            "flex size-10 shrink-0 items-center justify-center rounded-xl",
            project.status === "ready" ? "bg-accent-soft text-accent" : "bg-surface-3 text-fg-2",
          )}
        >
          {codes ? (
            <span className="text-xs font-semibold tabular-nums">{codes.split(",")[0]}</span>
          ) : sources.length === 2 ? (
            <Mic className="size-[18px]" />
          ) : (
            <FileAudio className="size-[18px]" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-fg">{project.name}</span>
            {project.tags.slice(0, 3).map((tag) => (
              <span key={tag} className="hidden shrink-0 rounded-full bg-surface-3 px-2 py-0.5 text-[11px] text-fg-2 sm:inline">
                {tag}
              </span>
            ))}
            {project.tags.length > 3 && <span className="text-[11px] text-muted">+{project.tags.length - 3}</span>}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
            {showStudy && study && <span className="shrink-0 font-medium text-fg-2">{study.name}</span>}
            {showStudy && study && <span aria-hidden>·</span>}
            {codes && codes.includes(",") && <span className="shrink-0">{codes}</span>}
            {codes && codes.includes(",") && <span aria-hidden>·</span>}
            {files && <span className="truncate">{files}</span>}
            {files && seconds > 0 && <span aria-hidden>·</span>}
            {seconds > 0 && <span className="shrink-0 tabular-nums">{formatDuration(seconds)}</span>}
          </span>
          {running && <Progress value={job.fraction} className="mt-2 h-1 max-w-56" />}
          {stage === "importing" && <Progress value={importPct ?? 0} className="mt-2 h-1 max-w-56" />}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1.5">
          <StageBadge stage={stage} pct={importPct} />
          <span className="text-xs text-muted tabular-nums">{shortDay(interviewDate(project), lang)}</span>
        </span>
      </button>
      <div className="pr-3">
        <Menu
          trigger={
            <IconButton label={t("home.more")} size="sm" className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100">
              <MoreHorizontal className="size-4" />
            </IconButton>
          }
        >
          <MenuItem icon={<FolderOpen />} onSelect={() => openRoute(project)}>
            {t("home.open")}
          </MenuItem>
          <MenuItem icon={<Pencil />} onSelect={onRename}>
            {t("home.rename")}
          </MenuItem>
          <MenuItem icon={<FolderInput />} onSelect={onMove}>
            {t("library.moveTo")}
          </MenuItem>
          <MenuItem icon={<Share2 />} disabled={project.status !== "ready"} onSelect={() => void exportShare(t, { project })}>
            {t("share.export")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger icon={<Trash2 />} onSelect={onDelete}>
            {t("common.delete")}
          </MenuItem>
        </Menu>
      </div>
    </li>
  );
}

// ------------------------------------------------------------------ dialogs

/**
 * "New transcription": what kind of recording it is, and one place to drop or pick audio or
 * video (the app takes the sound from a video file).
 */
function ImportDialog({
  open,
  title,
  kind,
  onKind,
  onClose,
  onFiles,
  onArchive,
}: {
  open: boolean;
  title: string;
  kind: RecordingKind;
  onKind: (kind: RecordingKind) => void;
  onClose: () => void;
  onFiles: (paths: string[]) => void;
  /** Import a ZIP file shared by a colleague instead. */
  onArchive: () => void;
}) {
  const t = useT();
  const browse = async () => {
    try {
      const paths = await pickAudioFiles(true);
      if (paths.length > 0) onFiles(paths);
    } catch (e) {
      fail(e);
    }
  };
  const kinds = [
    { id: "conversation", icon: <MessagesSquare />, label: t("library.kindConversation"), hint: t("library.kindConversationHint") },
    { id: "lecture", icon: <Presentation />, label: t("library.kindLecture"), hint: t("library.kindLectureHint") },
  ] as const;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={title} width={560}>
      <div className="flex flex-col gap-4 pb-3">
        <div>
          <div id="import-kind" className="mb-2 text-[13px] font-medium">
            {t("library.importKind")}
          </div>
          <div role="radiogroup" aria-labelledby="import-kind" className="grid grid-cols-2 gap-2">
            {kinds.map((k) => (
              <button
                key={k.id}
                type="button"
                role="radio"
                aria-checked={kind === k.id}
                onClick={() => onKind(k.id)}
                className={cx(
                  "flex items-start gap-2.5 rounded-xl border p-3 text-left transition-colors",
                  kind === k.id ? "border-accent bg-accent-soft ring-2 ring-accent/15" : "border-line hover:bg-surface-2",
                )}
              >
                <span className={cx("mt-0.5 shrink-0 [&>svg]:size-4", kind === k.id ? "text-accent" : "text-muted")}>{k.icon}</span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold">{k.label}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-fg-2">{k.hint}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void browse()}
          className="flex flex-col items-center rounded-2xl border-2 border-dashed border-line-strong px-6 py-9 text-center transition-colors hover:border-accent/60 hover:bg-surface-2"
        >
          <span className="mb-3 flex gap-2 text-muted" aria-hidden>
            <FileAudio className="size-7" />
            <FileVideo className="size-7" />
          </span>
          <span className="text-sm font-semibold">{t("library.importDrop")}</span>
          <span className="mt-0.5 text-[13px] text-fg-2">{t("library.importBrowse")}</span>
          <span className="mt-3 text-xs text-muted">{t("library.importFormats")}</span>
        </button>
        <p className="text-xs leading-relaxed text-muted">{t(kind === "conversation" ? "library.importTwoMics" : "library.importSeveral")}</p>
        <button type="button" onClick={onArchive} className="flex items-center gap-2 self-start text-xs font-medium text-accent hover:underline">
          <FileArchive className="size-3.5" />
          {t("share.import")}
          <span className="font-normal text-muted">{t("share.importHint")}</span>
        </button>
      </div>
    </Dialog>
  );
}

function TwoFilesDialog({
  paths,
  onClose,
  onSame,
  onSeparate,
}: {
  paths: string[] | null;
  onClose: () => void;
  onSame: (paths: string[]) => void;
  onSeparate: (paths: string[]) => void;
}) {
  const t = useT();
  const names = (paths ?? []).map((p) => p.split(/[\\/]/).pop()).join(" + ");
  return (
    <Dialog
      open={paths !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("library.twoFilesTitle")}
      description={t("library.twoFilesBody")}
      footer={
        <>
          <Button
            variant="soft"
            onClick={() => {
              if (paths) onSeparate(paths);
              onClose();
            }}
          >
            {t("library.twoFilesSeparate")}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              if (paths) onSame(paths);
              onClose();
            }}
          >
            {t("library.twoFilesSame")}
          </Button>
        </>
      }
    >
      <p className="truncate text-[13px] text-fg-2">{names}</p>
    </Dialog>
  );
}

function MoveDialog({ project, studies, onClose, onDone }: { project: Project | null; studies: Study[]; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setTarget(project?.studyId ?? ""), [project]);

  const submit = async () => {
    if (!project) return;
    setBusy(true);
    try {
      await api.updateProject(project.id, { studyId: target });
      await useApp.getState().refreshStudies();
      onDone();
      onClose();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={project !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("library.moveTo")}
      description={project?.name}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" loading={busy} disabled={target === (project?.studyId ?? "")} onClick={() => void submit()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <Select value={target} onChange={(e) => setTarget(e.target.value)} className="w-full" aria-label={t("interview.study")}>
        <option value="">{t("library.noStudy")}</option>
        {studies.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
    </Dialog>
  );
}

function RenameDialog({ project, onClose, onDone }: { project: Project | null; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (project) setName(project.name);
  }, [project]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = name.trim();
    if (!project || !trimmed) return;
    setBusy(true);
    try {
      await api.updateProject(project.id, { name: trimmed });
      onDone();
      onClose();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={project !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("home.rename")}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void submit()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        <TextInput autoFocus aria-label={t("setup.name")} value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
      </form>
    </Dialog>
  );
}

function DeleteDialog({ project, onClose, onDone }: { project: Project | null; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (!project) return;
    setBusy(true);
    try {
      await api.deleteProject(project.id);
      if (project.studyId) await useApp.getState().refreshStudies();
      onDone();
      onClose();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={project !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("home.deleteTitle")}
      description={project ? t("home.deleteBody", { name: project.name }) : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" loading={busy} onClick={confirm} icon={<Trash2 className="size-4" />}>
            {t("home.deleteConfirm")}
          </Button>
        </>
      }
    >
      <div className="[&>div]:bg-surface-2 [&>div]:text-fg-2">
        <Callout tone="warn" icon={<AlertTriangle />}>
          {t("home.deleteNote")}
        </Callout>
      </div>
    </Dialog>
  );
}

function EmptyState({ study, action }: { study: Study | undefined; action: ReactNode }) {
  const t = useT();
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-line-strong bg-surface px-6 py-16 text-center">
      <div className="relative mb-7 h-24 w-32" aria-hidden>
        <span className="absolute top-3 left-0 flex size-14 -rotate-6 items-center justify-center rounded-2xl border border-line bg-surface-2 text-muted shadow-card">
          <FileAudio className="size-6" />
        </span>
        <span className="absolute top-3 right-0 flex size-14 rotate-6 items-center justify-center rounded-2xl border border-line bg-surface-2 text-muted shadow-card">
          <Mic className="size-6" />
        </span>
        <span className="absolute top-0 left-1/2 flex size-16 -translate-x-1/2 items-center justify-center gap-1 rounded-2xl bg-accent shadow-pop">
          {[10, 18, 26, 16, 8].map((h, i) => (
            <span key={i} className="w-1 rounded-full bg-accent-fg" style={{ height: h }} />
          ))}
        </span>
      </div>
      <h2 className="text-base font-semibold tracking-tight">{study ? t("library.studyEmpty") : t("home.empty")}</h2>
      <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-fg-2">{study ? t("library.studyEmptyHint") : t("home.emptyHint")}</p>
      <div className="mt-6">{action}</div>
    </div>
  );
}
