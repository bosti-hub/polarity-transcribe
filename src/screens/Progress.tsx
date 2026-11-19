// Transcription progress: a calm card with the overall percentage, the stage list, time left
// and the most recently recognised text. Pausing, resuming and failures are handled here too.

import { AlertCircle, ArrowLeft, Check, Laptop, Layers, LogOut, Pause, Play, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { Frame } from "@/components/Frame";
import { Button, Callout, Progress, Spinner, cx } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useT, type TFn } from "@/lib/i18n";
import { useApp } from "@/lib/store";
import { formatDuration } from "@/lib/transcript";
import type { JobProgress, JobStage, Project } from "@/lib/types";

const toastError = (e: unknown) => void useApp.getState().toast(errorMessage(e), "error");

function stageList(project: Project | null, current: JobStage | undefined): JobStage[] {
  const list: JobStage[] = ["prepare"];
  if (project?.layout === "dual_file") list.push("sync");
  list.push("voice", "speakers", "transcribe", "finish");
  // Stages the backend reports that are not in the default list still get a row.
  if (current && !list.includes(current)) list.splice(list.length - 1, 0, current);
  return list;
}

export function ProgressScreen({ projectId }: { projectId: string }) {
  const t = useT();
  const go = useApp((s) => s.go);
  const live = useApp((s) => s.jobs[projectId]);
  const [project, setProject] = useState<Project | null>(null);
  const [fetched, setFetched] = useState<JobProgress | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [resuming, setResuming] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([api.getProject(projectId), api.jobStatus(projectId)])
      .then(([p, status]) => {
        if (!alive) return;
        setProject(p);
        setFetched(status);
        setLoaded(true);
      })
      .catch((e) => {
        if (alive) setLoaded(true);
        toastError(e);
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  const job = live ?? fetched;
  const state = job?.state ?? null;
  const running = state === "running";
  const failed = state === "error" || (!job && project?.status === "failed");
  const done = state === "done" || (loaded && !running && project?.status === "ready");

  useEffect(() => {
    if (done) go({ name: "editor", id: projectId });
  }, [done, go, projectId]);

  // "Stopping…" and "resuming" last until the backend reports a new state.
  useEffect(() => {
    if (state !== "running") setStopping(false);
    if (state === "running" || state === "error") setResuming(false);
  }, [state, job]);

  const stop = () => {
    setStopping(true);
    api.cancelJob(projectId).catch((e) => {
      setStopping(false);
      toastError(e);
    });
  };

  const resume = () => {
    setResuming(true);
    api.startJob(projectId).catch((e) => {
      setResuming(false);
      toastError(e);
    });
  };

  const fraction = job?.fraction ?? 0;
  const pct = Math.floor(fraction * 100);
  const stages = stageList(project, job?.stage);
  const currentIndex = job ? stages.indexOf(job.stage) : -1;
  const paused = loaded && !running && !failed && !done;
  // Interrupted in an earlier session: there are no numbers to show, only that it can go on.
  const idle = paused && !job;
  const errorText = job?.error ?? project?.error ?? null;

  return (
    <Frame title={project?.name ?? ""} subtitle={t("progress.title")} onBack={() => go({ name: "home" })}>
      <div className="flex min-h-full items-center justify-center px-6 py-10">
        {!loaded ? (
          <Spinner className="size-6" />
        ) : (
          <div className="flex w-full max-w-[640px] flex-col gap-4">
            {/* Not obvious otherwise: leaving this screen does not stop the transcription. */}
            {!failed && !paused && (
              <Callout icon={<Layers />}>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{t("progress.backgroundTitle")}</span>
                    <span className="mt-0.5 block text-[13px] text-fg-2">{t("progress.backgroundBody")}</span>
                  </span>
                  <Button variant="secondary" size="sm" icon={<ArrowLeft className="size-3.5" />} onClick={() => go({ name: "home" })}>
                    {t("progress.toOverview")}
                  </Button>
                </div>
              </Callout>
            )}
          <div className="anim-pop w-full rounded-2xl border border-line bg-surface p-7 shadow-card sm:p-8">
            {idle ? (
              <div className="flex flex-col items-center py-4 text-center">
                <span className="flex size-12 items-center justify-center rounded-full bg-warn-soft text-warn">
                  <Pause className="size-5" />
                </span>
                <h2 className="mt-4 text-lg font-semibold text-fg">{t("progress.pausedTitle")}</h2>
                <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-fg-2">{t("progress.pausedBody")}</p>
              </div>
            ) : (
              <>
            {/* Percentage and bar */}
                <div className="flex items-end justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-fg-2">
                      {job ? t(`progress.stage_${job.stage}`) : t("progress.title")}
                    </div>
                    <div className="tabular mt-1 text-[44px] leading-none font-semibold tracking-tight text-fg">
                      {pct}
                      <span className="ml-0.5 text-[24px] font-medium text-muted">%</span>
                    </div>
                  </div>
                  <div className="pb-1 text-right text-[13px] text-fg-2">
                    {running &&
                      (job?.etaSeconds != null ? t("progress.remaining", { dur: formatDuration(job.etaSeconds) }) : t("progress.calculating"))}
                  </div>
                </div>
                <Progress value={fraction} className="mt-5 h-2" />

                {/* Stages */}
                <ol className="mt-7 flex flex-col gap-0.5">
                  {stages.map((stage, i) => {
                    const status = state === "done" || i < currentIndex ? "done" : i === currentIndex ? "active" : "pending";
                    return <StageRow key={stage} t={t} stage={stage} status={status} paused={!running} />;
                  })}
                </ol>

                {/* Live preview */}
                {!failed && (
                  <div className="mt-6 rounded-xl bg-surface-2 px-4 py-3.5">
                    <div className="text-[11px] font-semibold tracking-wide text-muted uppercase">{t("progress.livePreview")}</div>
                    <LivePreview text={job?.preview ?? null} />
                  </div>
                )}

              </>
            )}

            {/* State-specific actions */}
            <div className="mt-6">
              {failed ? (
                <div className="flex flex-col gap-4">
                  <Callout tone="danger" icon={<AlertCircle />}>
                    <div className="font-medium">{t("progress.failed")}</div>
                    {errorText && <div className="selectable mt-1 font-mono text-xs break-words text-fg-2">{errorText}</div>}
                  </Callout>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button variant="ghost" onClick={() => go({ name: "setup", id: projectId })}>
                      {t("progress.backToSetup")}
                    </Button>
                    <Button variant="primary" loading={resuming} onClick={resume}>
                      {t("common.retry")}
                    </Button>
                  </div>
                </div>
              ) : paused ? (
                <div className={cx("flex flex-wrap items-center gap-3", idle && "justify-center")}>
                  {!idle && (
                    <span className="flex flex-1 items-center gap-2 text-[13px] text-fg-2">
                      <Pause className="size-4 text-muted" />
                      {t("progress.paused")}
                    </span>
                  )}
                  <Button variant="primary" icon={<Play className="size-4" />} loading={resuming} onClick={resume}>
                    {t("progress.resume")}
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5 text-xs text-muted">
                    <span className="flex items-start gap-2">
                      <Laptop className="mt-px size-3.5 shrink-0" />
                      {t("progress.keepAwake")}
                    </span>
                    <span className="flex items-start gap-2">
                      <LogOut className="mt-px size-3.5 shrink-0" />
                      {t("progress.closeOk")}
                    </span>
                  </div>
                  <div className="flex justify-end">
                    <Button variant="secondary" icon={stopping ? undefined : <Square className="size-3.5" />} loading={stopping} onClick={stop}>
                      {stopping ? t("progress.stopping") : t("progress.stop")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
          </div>
        )}
      </div>
    </Frame>
  );
}

function StageRow({ t, stage, status, paused }: { t: TFn; stage: JobStage; status: "done" | "active" | "pending"; paused: boolean }) {
  return (
    <li className={cx("flex h-8 items-center gap-3 rounded-lg px-2 text-[13px]", status === "active" && "bg-accent-soft")}>
      <span className="flex size-5 shrink-0 items-center justify-center">
        {status === "done" ? (
          <span className="flex size-4 items-center justify-center rounded-full bg-ok text-white">
            <Check className="size-3" strokeWidth={3} />
          </span>
        ) : status === "active" ? (
          paused ? <Pause className="size-3.5 text-accent" /> : <Spinner className="size-4 text-accent" />
        ) : (
          <span className="size-2 rounded-full bg-line-strong" />
        )}
      </span>
      <span className={cx(status === "pending" ? "text-muted" : status === "active" ? "font-medium text-fg" : "text-fg-2")}>
        {t(`progress.stage_${stage}`)}
      </span>
    </li>
  );
}

/** The latest recognised text. Updates without text (other stages, silent stretches) keep the last line. */
function LivePreview({ text }: { text: string | null }) {
  const [shown, setShown] = useState(text);

  // Adjusting state during render when the prop changes (no effect needed).
  if (text && text !== shown) setShown(text);

  return (
    <div className="mt-1.5 min-h-[3.25rem] text-sm leading-relaxed text-fg-2 italic">
      {shown ? (
        <p key={shown} className="line-clamp-2" style={{ animation: "fade-in 0.4s ease-out" }}>
          {shown}
        </p>
      ) : (
        <span className="text-muted not-italic">…</span>
      )}
    </div>
  );
}
