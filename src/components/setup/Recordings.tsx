// The recordings block of the setup screen: drop zone, one card per recording (or per running
// import), the "add a second recording" card, the stereo choice and the speaker count.

import { AlertTriangle, Ellipsis, FileAudio, Plus, Replace, Trash2, Upload, X } from "lucide-react";
import { Badge, Callout, IconButton, Menu, MenuItem, Progress, Segmented, cx } from "@/components/ui";
import { useT } from "@/lib/i18n";
import { formatClock } from "@/lib/transcript";
import type { Project, Source } from "@/lib/types";

export interface ImportState {
  fraction: number;
  fileName: string;
}

export function Recordings({
  project,
  imports,
  dropHover,
  onPick,
  onReplace,
  onRemove,
  onCancelImport,
  onStereoMode,
  onSpeakers,
}: {
  project: Project;
  imports: Record<number, ImportState | undefined>;
  dropHover: boolean;
  onPick: () => void;
  onReplace: (slot: number) => void;
  onRemove: (slot: number) => void;
  onCancelImport: (slot: number) => void;
  onStereoMode: (mode: "mono" | "split") => void;
  onSpeakers: (n: number) => void;
}) {
  const t = useT();
  const slots = [0, 1];
  const filled = slots.filter((s) => project.sources[s] || imports[s]);
  const sources = slots.map((s) => project.sources[s]).filter((s): s is Source => !!s);
  const stereo = sources.length === 1 && filled.length === 1 && sources[0].channels === 2 ? sources[0] : null;

  if (filled.length === 0) {
    return (
      <button
        type="button"
        onClick={onPick}
        className={cx(
          "group flex w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-14 text-center transition-colors",
          dropHover ? "border-accent bg-accent-soft" : "border-line-strong bg-surface hover:border-accent hover:bg-surface-2",
        )}
      >
        <span
          className={cx(
            "flex size-12 items-center justify-center rounded-2xl transition-colors",
            dropHover ? "bg-accent text-accent-fg" : "bg-accent-soft text-accent group-hover:bg-accent group-hover:text-accent-fg",
          )}
        >
          <Upload className="size-5" />
        </span>
        <span className="text-[15px] font-semibold text-fg">{t("setup.addFirst")}</span>
        <span className="max-w-md text-[13px] text-muted">{t("setup.addFirstHint")}</span>
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {slots.map((slot) => {
          const imp = imports[slot];
          const src = project.sources[slot];
          if (imp) return <ImportingCard key={slot} slot={slot} state={imp} onCancel={() => onCancelImport(slot)} />;
          if (src) return <SourceCard key={slot} slot={slot} source={src} onReplace={() => onReplace(slot)} onRemove={() => onRemove(slot)} />;
          return null;
        })}
        {filled.length === 1 && (
          <button
            type="button"
            onClick={onPick}
            className={cx(
              "flex items-start gap-3 rounded-xl border border-dashed p-4 text-left transition-colors",
              dropHover ? "border-accent bg-accent-soft" : "border-line-strong hover:border-accent hover:bg-surface-2",
            )}
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-fg-2">
              <Plus className="size-4" />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium text-fg">{t("setup.addSecond")}</span>
              <span className="text-xs leading-relaxed text-muted">{t("setup.addSecondHint")}</span>
            </span>
          </button>
        )}
      </div>

      {stereo && stereo.stereo.kind !== "mono" && (
        <div className="flex flex-col gap-3 rounded-xl bg-surface-2 p-4 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-fg">{t("setup.stereoTitle")}</span>
              <Badge tone={project.splitStereo === null ? "accent" : "neutral"}>
                {project.splitStereo === null ? t("setup.stereoAuto") : t("setup.stereoManual")}
              </Badge>
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-fg-2">{t(`setup.stereo_${stereo.stereo.kind}`)}</p>
          </div>
          <Segmented
            value={project.layout === "split_stereo" ? "split" : "mono"}
            onChange={onStereoMode}
            options={[
              { value: "mono", label: t("setup.stereoAsOne") },
              { value: "split", label: t("setup.stereoAsTwo") },
            ]}
          />
        </div>
      )}

      {project.layout === "single" && sources.length > 0 && (
        <div className="flex flex-col gap-3 rounded-xl bg-surface-2 p-4 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-fg">{t("setup.speakers")}</div>
            <p className="mt-1 text-[13px] leading-relaxed text-fg-2">{t("setup.speakersHint")}</p>
          </div>
          <Segmented
            value={String(project.speakerCount === 1 ? 1 : project.speakerCount >= 3 ? 3 : 2) as "1" | "2" | "3"}
            onChange={(v) => onSpeakers(Number(v))}
            options={[
              { value: "1", label: "1" },
              { value: "2", label: "2" },
              { value: "3", label: "3" },
            ]}
          />
        </div>
      )}
    </div>
  );
}

function TrackLabel({ slot }: { slot: number }) {
  const t = useT();
  return (
    <span className="flex items-center gap-1.5 text-xs font-medium text-fg-2">
      <span className="size-2 rounded-full" style={{ background: slot === 0 ? "var(--sp1)" : "var(--sp2)" }} />
      {t("setup.track", { n: slot + 1 })}
    </span>
  );
}

function SourceCard({ slot, source, onReplace, onRemove }: { slot: number; source: Source; onReplace: () => void; onRemove: () => void }) {
  const t = useT();
  const clipped = Math.max(source.stereo.clippedLeft, source.stereo.clippedRight) > 0.002;
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-card">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-fg-2">
          <FileAudio className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <TrackLabel slot={slot} />
          <div className="mt-0.5 truncate text-sm font-medium text-fg" title={source.originalPath}>
            {source.fileName}
          </div>
          <div className="tabular text-xs text-muted">{formatClock(source.duration)}</div>
        </div>
        <Menu
          trigger={
            <IconButton label={`${t("setup.replace")} · ${t("setup.removeFile")}`} size="sm">
              <Ellipsis className="size-4" />
            </IconButton>
          }
        >
          <MenuItem icon={<Replace />} onSelect={onReplace}>
            {t("setup.replace")}
          </MenuItem>
          <MenuItem icon={<Trash2 />} danger onSelect={onRemove}>
            {t("setup.removeFile")}
          </MenuItem>
        </Menu>
      </div>
      {clipped && (
        <Callout tone="warn" icon={<AlertTriangle />}>
          {t("setup.clipWarning")}
        </Callout>
      )}
    </div>
  );
}

function ImportingCard({ slot, state, onCancel }: { slot: number; state: ImportState; onCancel: () => void }) {
  const t = useT();
  const pct = Math.round(state.fraction * 100);
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-card">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <FileAudio className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <TrackLabel slot={slot} />
          <div className="mt-0.5 truncate text-sm font-medium text-fg">{state.fileName}</div>
          <div className="tabular text-xs text-muted">{t("setup.importing", { pct })}</div>
        </div>
        <IconButton label={t("common.cancel")} size="sm" onClick={onCancel}>
          <X className="size-4" />
        </IconButton>
      </div>
      <Progress value={state.fraction} />
    </div>
  );
}

