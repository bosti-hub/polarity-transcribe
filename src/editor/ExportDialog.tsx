import { AlertTriangle, BookOpen, FileCode2, FileText, FileType2, Info, Microscope, Sheet, Subtitles, Table2 } from "lucide-react";
import { useState } from "react";
import { Button, Callout, cx, Dialog, Segmented, Select, Switch } from "@/components/ui";
import { useQuoteExport, type QuoteSource } from "@/components/QuoteExport";
import { exportTranscript, HAS_LAYOUT, type ExportFormat, type ExportOptions } from "@/export";
import type { PauseNotation } from "@/export/notation";
import { api, errorMessage } from "@/lib/api";
import { useT, type TKey } from "@/lib/i18n";
import { exportContext } from "@/lib/interviews";
import { pickSavePath } from "@/lib/platform";
import { useApp } from "@/lib/store";
import { formatClock } from "@/lib/transcript";
import type { AnonymizeRule, Project, Transcript } from "@/lib/types";

export interface FormatInfo {
  id: ExportFormat;
  label: TKey;
  hint?: TKey;
  icon: React.ReactNode;
}

export const FORMAT_GROUPS: { label: TKey; formats: FormatInfo[] }[] = [
  {
    label: "export.groupReading",
    formats: [
      { id: "docx", label: "export.docx", hint: "export.docxHint", icon: <FileType2 className="size-4" /> },
      { id: "txt", label: "export.txt", icon: <FileText className="size-4" /> },
      { id: "md", label: "export.md", icon: <BookOpen className="size-4" /> },
    ],
  },
  {
    label: "export.groupAnalysis",
    formats: [
      { id: "maxqda", label: "export.maxqda", hint: "export.maxqdaHint", icon: <Microscope className="size-4" /> },
      { id: "nvivo", label: "export.nvivo", hint: "export.nvivoHint", icon: <Table2 className="size-4" /> },
      { id: "csv", label: "export.csv", hint: "export.csvHint", icon: <Sheet className="size-4" /> },
    ],
  },
  {
    label: "export.groupSubtitles",
    formats: [
      { id: "srt", label: "export.srt", icon: <Subtitles className="size-4" /> },
      { id: "vtt", label: "export.vtt", icon: <Subtitles className="size-4" /> },
    ],
  },
  { label: "export.groupData", formats: [{ id: "json", label: "export.json", icon: <FileCode2 className="size-4" /> }] },
];

/** The formats as cards in labelled groups; shared with the study export. */
export function FormatPicker({ value, onChange, only }: { value: ExportFormat; onChange: (f: ExportFormat) => void; only?: ExportFormat[] }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3" role="radiogroup" aria-label={t("export.format")}>
      {FORMAT_GROUPS.map((g) => {
        const formats = g.formats.filter((f) => !only || only.includes(f.id));
        if (formats.length === 0) return null;
        return (
          <div key={g.label}>
            <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">{t(g.label)}</div>
            <div className="grid grid-cols-2 gap-1.5">
              {formats.map((f) => (
                <button
                  key={f.id}
                  role="radio"
                  aria-checked={value === f.id}
                  onClick={() => onChange(f.id)}
                  className={cx(
                    "flex items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors",
                    value === f.id ? "border-accent bg-accent-soft" : "border-line hover:bg-surface-2",
                  )}
                >
                  <span className={cx("mt-0.5", value === f.id ? "text-accent" : "text-muted")}>{f.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{t(f.label)}</span>
                    {f.hint && <span className="block text-xs leading-snug text-muted">{t(f.hint)}</span>}
                  </span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Timestamps, numbering and the reading version; shared with the study export. */
export function FormatOptions({
  format,
  timestamps,
  onTimestamps,
  numbering,
  onNumbering,
  clean,
  onClean,
  anonymize,
  notation,
  onNotation,
}: {
  format: ExportFormat;
  timestamps: boolean;
  onTimestamps: (v: boolean) => void;
  numbering: ExportOptions["numbering"];
  onNumbering: (v: ExportOptions["numbering"]) => void;
  clean: boolean;
  onClean: (v: boolean) => void;
  /** The pseudonymise switch, shown when there are rules. */
  anonymize?: { rules: number; value: boolean; onChange: (v: boolean) => void };
  notation: PauseNotation;
  onNotation: (v: PauseNotation) => void;
}) {
  const t = useT();
  const layout = HAS_LAYOUT.includes(format);
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-surface-2 px-3.5 py-3">
      {layout && (
        <>
          <label className="flex items-center justify-between gap-3 text-sm">
            {t("export.timestamps")}
            <Switch checked={timestamps} onChange={onTimestamps} label={t("export.timestamps")} />
          </label>
          <div className="flex items-center justify-between gap-3 text-sm">
            {t("export.numbering")}
            <Segmented
              size="sm"
              value={numbering === "line" && format !== "docx" ? "paragraph" : numbering}
              onChange={onNumbering}
              options={[
                { value: "none", label: t("export.numberingNone") },
                { value: "paragraph", label: t("export.numberingParagraph") },
                ...(format === "docx" ? [{ value: "line" as const, label: t("export.numberingLine") }] : []),
              ]}
            />
          </div>
        </>
      )}
      {format !== "srt" && format !== "vtt" && format !== "json" && !clean && (
        <div className="flex items-center justify-between gap-3 text-sm">
          {t("export.notation")}
          <Select
            aria-label={t("export.notation")}
            value={notation}
            onChange={(e) => onNotation(e.target.value as PauseNotation)}
            className="h-8 text-[13px]"
          >
            <option value="polarity">{t("export.notationPolarity")}</option>
            <option value="dresing">{t("export.notationDresing")}</option>
            <option value="jefferson">{t("export.notationJefferson")}</option>
          </Select>
        </div>
      )}
      <label className="flex items-center justify-between gap-3 text-sm">
        <span>
          {t("export.clean")}
          <span className="block text-xs text-muted">{t("export.cleanHint")}</span>
        </span>
        <Switch checked={clean} onChange={onClean} label={t("export.clean")} />
      </label>
      {anonymize && anonymize.rules > 0 && (
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>
            {t("export.anonymize")}
            <span className="block text-xs text-muted">{t("export.anonymizeHint", { n: anonymize.rules })}</span>
          </span>
          <Switch checked={anonymize.value} onChange={anonymize.onChange} label={t("export.anonymize")} />
        </label>
      )}
    </div>
  );
}

/** The pause notation, remembered between exports (researchers stick to one convention). */
export function useNotation(): [PauseNotation, (v: PauseNotation) => void] {
  const [value, setValue] = useState<PauseNotation>(() => {
    try {
      const v = localStorage.getItem("pt.notation");
      return v === "dresing" || v === "jefferson" ? v : "polarity";
    } catch {
      return "polarity";
    }
  });
  const set = (v: PauseNotation) => {
    setValue(v);
    try {
      localStorage.setItem("pt.notation", v);
    } catch {
      // Remembering is a convenience only.
    }
  };
  return [value, set];
}

export function ExportDialog({
  open,
  onOpenChange,
  project,
  rules,
  getTranscript,
  doubts,
  quotes,
  tab,
  onTab,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  /** Pseudonymisation rules of the interview and its study. */
  rules: AnonymizeRule[];
  /** Returns the transcript as it is in the editor right now. */
  getTranscript: () => Transcript;
  doubts: number;
  /** The interview's quotes, for the Quotes tab. */
  quotes: QuoteSource;
  tab: ExportTab;
  onTab: (tab: ExportTab) => void;
}) {
  const t = useT();
  const uiLanguage = useApp((s) => s.settings.uiLanguage);
  const toast = useApp((s) => s.toast);
  const study = useApp((s) => s.studies.find((x) => x.id === project.studyId));
  const [format, setFormat] = useState<ExportFormat>("docx");
  const [timestamps, setTimestamps] = useState(true);
  const [numbering, setNumbering] = useState<ExportOptions["numbering"]>("none");
  const [clean, setClean] = useState(false);
  const [anonymize, setAnonymize] = useState(true);
  const [notation, setNotation] = useNotation();
  const [withAudio, setWithAudio] = useRemembered<boolean>("pt.exportAudio", false);
  const [audioFormat, setAudioFormat] = useRemembered<AudioFormat>("pt.exportAudioFormat", "mp3");
  const [busy, setBusy] = useState(false);
  const context = exportContext(project, study);
  // With the audio alongside, times count from the start of that file (it is trimmed already);
  // without it, they match the original recording.
  const offset = withAudio ? 0 : context.offset;
  const quoteExport = useQuoteExport(quotes, () => onOpenChange(false));

  const run = async () => {
    setBusy(true);
    try {
      const result = await exportTranscript(getTranscript(), {
        ...context,
        offset,
        format,
        timestamps,
        numbering,
        uiLanguage,
        clean,
        anonymize: anonymize ? rules : undefined,
        notation,
      });
      const path = await pickSavePath(result.fileName, result.extension);
      if (!path) return;
      await api.writeFile(path, result.bytes);
      if (withAudio) await api.exportRecording(project.id, `${path.replace(/\.[^.\\/]+$/, "")}.${audioFormat}`);
      onOpenChange(false);
      toast(t("export.saved", { path }), "ok", { label: t("export.show"), run: () => void api.revealInFolder(path) });
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const onQuotes = tab === "quotes";
  const runQuotes = () => quoteExport.run().catch((e) => toast(errorMessage(e), "error"));
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !quoteExport.busy && onOpenChange(o)}
      title={onQuotes ? t("quoteExport.title") : t("export.title")}
      width={600}
      dismissable={!quoteExport.busy}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={quoteExport.busy}>
            {t("common.cancel")}
          </Button>
          {onQuotes ? (
            <Button variant="primary" loading={quoteExport.busy} disabled={quotes.count === 0} onClick={() => void runQuotes()}>
              {quoteExport.busyLabel ?? t("quoteExport.export")}
            </Button>
          ) : (
            <Button variant="primary" loading={busy} onClick={run}>
              {t("export.saveAs")}
            </Button>
          )}
        </>
      }
    >
      <ExportTabs tab={tab} onTab={onTab} quotes={quotes.count} />
      {onQuotes ? (
        quotes.count === 0 ? (
          <p className="py-6 text-center text-[13px] text-muted">{t("quotes.empty")}</p>
        ) : (
          quoteExport.form
        )
      ) : (
      <div className="flex flex-col gap-4">
        <FormatPicker value={format} onChange={setFormat} />
        <FormatOptions
          format={format}
          timestamps={timestamps}
          onTimestamps={setTimestamps}
          numbering={numbering}
          onNumbering={setNumbering}
          clean={clean}
          onClean={setClean}
          anonymize={{ rules: rules.length, value: anonymize, onChange: setAnonymize }}
          notation={notation}
          onNotation={setNotation}
        />
        {/* Not a <label>: that would hand clicks on the text to the format list instead of the switch. */}
        <div className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-3.5 py-3 text-sm">
          <span className="cursor-default" onClick={() => setWithAudio(!withAudio)}>
            {t("export.withAudio")}
            <span className="block text-xs text-muted">{t("export.withAudioHint")}</span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {withAudio && (
              <Select
                aria-label={t("quoteExport.audioFormat")}
                value={audioFormat}
                onChange={(e) => setAudioFormat(e.target.value as AudioFormat)}
                className="h-8 text-[13px]"
              >
                <option value="mp3">MP3</option>
                <option value="m4a">M4A (AAC)</option>
                <option value="wav">WAV</option>
              </Select>
            )}
            <Switch checked={withAudio} onChange={setWithAudio} label={t("export.withAudio")} />
          </span>
        </div>
        {offset > 0.5 && (
          <p className="flex gap-2 text-xs leading-relaxed text-muted">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            {t("export.offsetNote", { time: formatClock(offset) })}
          </p>
        )}
        {doubts > 0 && (
          <Callout tone="warn" icon={<AlertTriangle />}>
            {t("export.doubtsWarning", { n: doubts })}
          </Callout>
        )}
      </div>
      )}
    </Dialog>
  );
}

type AudioFormat = "mp3" | "m4a" | "wav";

/** A choice remembered between exports (whether the audio goes along, and in which format). */
function useRemembered<T extends string | boolean>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const v = localStorage.getItem(key);
      if (v === null) return fallback;
      return (typeof fallback === "boolean" ? v === "1" : v) as T;
    } catch {
      return fallback;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, typeof v === "boolean" ? (v ? "1" : "0") : v);
    } catch {
      // Remembering is a convenience only.
    }
  };
  return [value, set];
}

export type ExportTab = "transcript" | "quotes";

/** Transcript or quotes: the same dialog, two tabs. Shared with the study export. */
export function ExportTabs({ tab, onTab, quotes }: { tab: ExportTab; onTab: (tab: ExportTab) => void; quotes: number }) {
  const t = useT();
  return (
    <div className="mb-4">
      <Segmented
        value={tab}
        onChange={onTab}
        options={[
          { value: "transcript", label: t("export.tabTranscript") },
          { value: "quotes", label: `${t("quotes.title")} (${quotes})` },
        ]}
      />
    </div>
  );
}
