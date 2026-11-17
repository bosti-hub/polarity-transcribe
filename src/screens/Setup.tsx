// Recording setup: import one or two recordings, choose start and end, set options and start
// the transcription. Trim editing itself lives in components/setup/TrimPanel + Waveform.

import { AlertCircle, AudioLines, Clock, Download, Info, Pencil } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Frame, OfflineBadge } from "@/components/Frame";
import { InterviewDetails } from "@/components/InterviewDetails";
import { Options, type PatchFn } from "@/components/setup/Options";
import { Recordings, type ImportState } from "@/components/setup/Recordings";
import { TrimPanel } from "@/components/setup/TrimPanel";
import { Button, Callout, Dialog, Spinner, Tooltip } from "@/components/ui";
import { TimelineModel } from "@/components/Waveform";
import { api, errorMessage, events } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { onFileDrop, pickAudioFiles } from "@/lib/platform";
import { activeModel, useApp } from "@/lib/store";
import { formatDuration } from "@/lib/transcript";
import type { Project } from "@/lib/types";

const toastError = (e: unknown) => useApp.getState().toast(errorMessage(e), "error");

type Imports = Record<number, ImportState | undefined>;

/** Longest selected region over all recordings, in seconds. */
function selectedFromProject(p: Project): number {
  return p.sources.reduce((m, s) => (s ? Math.max(m, s.trimEnd - s.trimStart) : m), 0);
}

// ------------------------------------------------------------------ debounced saves

/** Named, debounced save jobs that can all be flushed at once (before starting, on unmount). */
function useSaver() {
  const pending = useRef(new Map<string, { timer: number; run: () => Promise<void> }>());

  const schedule = useCallback((key: string, ms: number, run: () => Promise<void>) => {
    const prev = pending.current.get(key);
    if (prev) clearTimeout(prev.timer);
    const timer = window.setTimeout(() => {
      pending.current.delete(key);
      void run();
    }, ms);
    pending.current.set(key, { timer, run });
  }, []);

  const flush = useCallback(async () => {
    const jobs = [...pending.current.values()];
    pending.current.clear();
    jobs.forEach((j) => clearTimeout(j.timer));
    await Promise.all(jobs.map((j) => j.run()));
  }, []);

  useEffect(() => () => void flush(), [flush]);
  return { schedule, flush };
}

// ------------------------------------------------------------------ screen

export function Setup({ projectId }: { projectId: string }) {
  const t = useT();
  const go = useApp((s) => s.go);
  const settings = useApp((s) => s.settings);
  const models = useApp((s) => s.models);
  const info = useApp((s) => s.info);

  const [project, setProject] = useState<Project | null>(null);
  const [imports, setImportsState] = useState<Imports>({});
  const [dropHover, setDropHover] = useState(false);
  const [model] = useState(() => new TimelineModel());
  const [selected, setSelected] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [starting, setStarting] = useState(false);

  const mounted = useRef(true);
  const projectRef = useRef<Project | null>(null);
  const importsRef = useRef<Imports>({});
  const cancelledImports = useRef(new Set<number>());
  const running = useRef(0);
  const tRef = useRef(t);
  const { schedule, flush } = useSaver();

  useEffect(() => {
    tRef.current = t;
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const applyProject = useCallback((p: Project) => {
    if (!mounted.current) return;
    projectRef.current = p;
    setProject(p);
  }, []);

  /** Imports state mirrored in a ref so drop handlers see slots claimed a moment ago. */
  const setImports = useCallback((fn: (s: Imports) => Imports) => {
    importsRef.current = fn(importsRef.current);
    if (mounted.current) setImportsState(importsRef.current);
  }, []);

  // ---- saving
  const patch: PatchFn = useCallback(
    (p, key) => {
      const run = () => api.updateProject(projectId, p).then(applyProject, toastError);
      if (key) schedule(key, 400, run);
      else void run();
    },
    [projectId, applyProject, schedule],
  );

  useEffect(() => {
    return model.subscribe((e) => {
      if (e !== "trim") return;
      schedule("trims", 300, async () => {
        const trims = model.tracks.map((tr, i) => ({ slot: tr.slot, start: model.trims[i].start, end: model.trims[i].end }));
        if (trims.length === 0) return;
        if (mounted.current) setSelected(Math.max(...trims.map((x) => x.end - x.start)));
        await api.updateProject(projectId, { trims }).then(applyProject, toastError);
      });
    });
  }, [model, projectId, schedule, applyProject]);

  // ---- importing
  const startImport = useCallback(
    (slot: number, path: string) => {
      const fileName = path.split(/[\\/]/).pop() ?? path;
      cancelledImports.current.delete(slot);
      setImports((s) => ({ ...s, [slot]: { fraction: 0, fileName } }));
      running.current++;
      api
        .importAudio(projectId, slot, path)
        .then((p) => {
          applyProject(p);
          setSelected(null);
        })
        .catch((e) => {
          if (!cancelledImports.current.has(slot) && mounted.current) {
            useApp.getState().toast(tRef.current("errors.importFailed", { msg: errorMessage(e) }), "error");
          }
        })
        .finally(() => {
          setImports((s) => ({ ...s, [slot]: undefined }));
          // Parallel imports each return a snapshot; re-read once all are done.
          if (--running.current === 0 && mounted.current) api.getProject(projectId).then(applyProject, toastError);
        });
    },
    [projectId, applyProject, setImports],
  );

  const addFiles = useCallback(
    (paths: string[]) => {
      const p = projectRef.current;
      if (!p || paths.length === 0) return;
      const free = [0, 1].filter((s) => !p.sources[s] && !importsRef.current[s]);
      if (paths.length > free.length) useApp.getState().toast(tRef.current("errors.tooManyFiles"), "error");
      paths.slice(0, free.length).forEach((path, i) => startImport(free[i], path));
    },
    [startImport],
  );

  const pick = useCallback(() => {
    pickAudioFiles(true).then(addFiles, toastError);
  }, [addFiles]);

  const replace = (slot: number) => {
    pickAudioFiles(false).then((paths) => {
      if (paths[0]) startImport(slot, paths[0]);
    }, toastError);
  };

  const remove = (slot: number) => {
    api.removeAudio(projectId, slot).then((p) => {
      applyProject(p);
      setSelected(null);
    }, toastError);
  };

  const cancelImport = (slot: number) => {
    cancelledImports.current.add(slot);
    api.cancelImport(projectId, slot).catch(toastError);
  };

  // ---- mount: load the project, then import files chosen on the home screen
  useEffect(() => {
    let alive = true;
    api
      .getProject(projectId)
      .then((p) => {
        if (!alive) return;
        applyProject(p);
        const paths = useApp.getState().takeImports(projectId);
        if (paths.length > 2) useApp.getState().toast(tRef.current("errors.tooManyFiles"), "error");
        paths.slice(0, 2).forEach((path, slot) => startImport(slot, path));
      })
      .catch(toastError);
    return () => {
      alive = false;
    };
  }, [projectId, applyProject, startImport]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let dead = false;
    events
      .importProgress((p) => {
        if (p.projectId !== projectId) return;
        setImports((s) => {
          const cur = s[p.slot];
          return cur ? { ...s, [p.slot]: { ...cur, fraction: p.fraction } } : s;
        });
      })
      .then((un) => {
        if (dead) un();
        else unlisten = un;
      }, toastError);
    return () => {
      dead = true;
      unlisten?.();
    };
  }, [projectId, setImports]);

  useEffect(() => onFileDrop({ onHover: setDropHover, onDrop: addFiles }), [addFiles]);

  // ---- starting
  const model_ = activeModel(models, settings);
  const importing = Object.values(imports).some(Boolean);
  const hasSource = !!project?.sources.some(Boolean);
  const canStart = !!model_ && hasSource && !importing && !starting;

  const start = async () => {
    setConfirmOpen(false);
    setStarting(true);
    try {
      await flush();
      await api.startJob(projectId);
      go({ name: "progress", id: projectId });
    } catch (e) {
      toastError(e);
      if (mounted.current) setStarting(false);
    }
  };

  const onStart = () => {
    if (!canStart) return;
    if (project?.status === "ready") setConfirmOpen(true);
    else void start();
  };

  if (!project) {
    return (
      <Frame title="" onBack={() => go({ name: "home" })} actions={<OfflineBadge />}>
        <div className="flex h-full items-center justify-center">
          <Spinner className="size-6" />
        </div>
      </Frame>
    );
  }

  const threads = Math.max(1, Math.min(8, info?.cpuThreads ?? 8));
  // Measured: 3 times real time on eight processor cores; a dedicated graphics card is many
  // times faster (56 times on a mid-range card), so a cautious 0.15 covers older cards too.
  // Laptop graphics chips are reported at three to four times the processor: 0.3 is cautious.
  const onGpu = !!info?.gpu && settings.useGpu;
  const gpuFactor = info?.gpuIntegrated ? 0.3 : 0.15;
  const factor = (onGpu ? gpuFactor : (0.55 * 8) / threads) * (settings.fastMode ? 0.7 : 1);
  const estimate = (selected ?? selectedFromProject(project)) * factor;

  return (
    <Frame
      title={<ProjectName name={project.name} onRename={(name) => patch({ name })} />}
      onBack={() => go({ name: "home" })}
      actions={<OfflineBadge />}
      bodyClassName="flex min-h-0 flex-1 flex-col"
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-6 px-6 pt-8 pb-12">
          {project.status === "failed" && (
            <Callout tone="danger" icon={<AlertCircle />}>
              <div className="font-medium">{t("progress.failed")}</div>
              {project.error && <div className="selectable mt-0.5 break-words text-fg-2">{project.error}</div>}
            </Callout>
          )}

          <h1 className="text-[22px] font-semibold tracking-tight text-fg">{t("setup.title")}</h1>

          <Recordings
            project={project}
            imports={imports}
            dropHover={dropHover}
            onPick={pick}
            onReplace={replace}
            onRemove={remove}
            onCancelImport={cancelImport}
            onStereoMode={(mode) => patch({ stereoMode: mode })}
            onSpeakers={(n) => patch({ speakerCount: n })}
          />

          {hasSource && (
            <Section title={t("setup.trimTitle")} hint={t("setup.trimHint")}>
              <TrimPanel project={project} model={model} />
            </Section>
          )}

          <Section title={t("setup.options")}>
            <Options project={project} onPatch={patch} />
          </Section>

          <Section title={t("interview.title")}>
            <InterviewDetails project={project} onChange={applyProject} />
          </Section>
        </div>
      </div>

      <footer className="shrink-0 border-t border-line bg-surface">
        <div className="mx-auto flex w-full max-w-[1040px] items-center gap-4 px-6 py-3">
          <div className="min-w-0 flex-1">
            {!model_ ? (
              <Callout tone="warn" icon={<Download />}>
                <div className="flex items-center gap-3">
                  <span className="flex-1">{t("setup.needModel")}</span>
                  <Button size="sm" onClick={() => go({ name: "settings" })}>
                    {t("common.settings")}
                  </Button>
                </div>
              </Callout>
            ) : hasSource ? (
              <div className="flex items-center gap-2 text-[13px] text-fg-2">
                <Clock className="size-4 shrink-0 text-muted" />
                <span className="truncate">{t("setup.estimate", { dur: formatDuration(estimate) })}</span>
                <Tooltip label={t("setup.estimateNote")}>
                  <span tabIndex={0} className="shrink-0 rounded text-muted hover:text-fg">
                    <Info className="size-4" />
                  </span>
                </Tooltip>
              </div>
            ) : null}
          </div>
          <Button variant="primary" size="lg" icon={<AudioLines className="size-[18px]" />} disabled={!canStart} loading={starting} onClick={onStart}>
            {t("setup.start")}
          </Button>
        </div>
      </footer>

      <Dialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("setup.retranscribeTitle")}
        description={t("setup.retranscribeBody")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" onClick={() => void start()}>
              {t("setup.start")}
            </Button>
          </>
        }
      />

      {dropHover && hasSource && (
        <div className="anim-fade pointer-events-none fixed inset-3 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-accent-soft/60">
          <span className="rounded-full bg-surface px-4 py-2 text-sm font-medium text-accent shadow-pop">{t("home.drop")}</span>
        </div>
      )}
    </Frame>
  );
}

// ------------------------------------------------------------------ pieces

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
      <div className="mb-5">
        <h2 className="text-[15px] font-semibold tracking-tight text-fg">{title}</h2>
        {hint && <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/** The project name in the header; click to rename inline. */
function ProjectName({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const skipCommit = useRef(false);

  const commit = () => {
    setEditing(false);
    if (skipCommit.current) {
      skipCommit.current = false;
      return;
    }
    const next = value.trim();
    if (next && next !== name) onRename(next);
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        aria-label={t("setup.name")}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") {
            skipCommit.current = true;
            e.currentTarget.blur();
          }
        }}
        className="-ml-1.5 h-8 w-full max-w-md rounded-md border border-accent bg-surface px-1.5 text-[15px] font-semibold tracking-tight text-fg ring-2 ring-accent/20 outline-none"
      />
    );
  }
  return (
    <button
      type="button"
      title={t("home.rename")}
      onClick={() => {
        setValue(name);
        setEditing(true);
      }}
      className="group -ml-1.5 inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-surface-3"
    >
      <span className="truncate">{name}</span>
      <Pencil className="size-3.5 shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}
