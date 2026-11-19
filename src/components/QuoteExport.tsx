// Quote export, shown as the "Quotes" tab of the export dialogs (interview and study): numbered,
// in the format the researcher wants, optionally with an audio fragment per quote cut from the
// interview's recording, with or without an anonymised voice. Everything goes into one new folder.

import { BookOpen, FileText, FileType2, Sheet, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { quoteLabel, quotesCsv, quotesDocx, quotesMarkdown, quotesText, type QuoteLine } from "@/export/quotes";
import { api } from "@/lib/api";
import { useT, type TKey } from "@/lib/i18n";
import { pickFolder } from "@/lib/platform";
import { useApp } from "@/lib/store";
import type { Language } from "@/lib/types";
import { Callout, cx, Segmented, Select, Switch } from "./ui";

/** One quote to export: where it is in which interview, and its text as it should appear. */
export interface QuoteExportItem {
  projectId: string;
  /** Start and end on the interview's transcript timeline (seconds). */
  s: number;
  e: number;
  line: QuoteLine;
  /** When pseudonymised names are spoken in it (transcript timeline), to beep them out of the audio. */
  spans: [number, number][];
}

/** What the export dialogs need to offer the quotes tab. */
export interface QuoteSource {
  /** Base name for the folder and the document, for example the interview's or study's name. */
  name: string;
  count: number;
  /** Whether there are pseudonymisation rules to apply. */
  hasPseudonyms: boolean;
  /** The quotes, in order, with or without pseudonyms applied to their text. */
  build: (pseudonymise: boolean) => QuoteExportItem[];
  /** Folder the folder picker starts in (an interview's: where its recording came from). */
  startFolder?: () => Promise<string | null>;
}

type Format = "docx" | "csv" | "txt" | "md";
type AudioFormat = "mp3" | "m4a" | "wav";
type Voice = "original" | "tv" | "whisper";

const FORMATS: { id: Format; label: TKey; icon: React.ReactNode }[] = [
  { id: "docx", label: "export.docx", icon: <FileType2 className="size-4" /> },
  { id: "csv", label: "export.csv", icon: <Sheet className="size-4" /> },
  { id: "txt", label: "export.txt", icon: <FileText className="size-4" /> },
  { id: "md", label: "export.md", icon: <BookOpen className="size-4" /> },
];

/** Characters that are not allowed in file names on Windows or macOS. */
function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "export";
}

/** The quotes tab: its form, and the action behind the dialog's main button. */
export function useQuoteExport(source: QuoteSource | undefined, onDone: () => void) {
  const t = useT();
  const lang = useApp((s) => s.settings.uiLanguage) as Language;
  const [format, setFormat] = useState<Format>("docx");
  const [numbered, setNumbered] = useState(true);
  const [audio, setAudio] = useState(true);
  const [audioFormat, setAudioFormat] = useState<AudioFormat>("mp3");
  const [margin, setMargin] = useState(0.5);
  const [voice, setVoice] = useState<Voice>("original");
  const [pseudonymise, setPseudonymise] = useState(true);
  const [bleep, setBleep] = useState(true);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const run = async () => {
    if (!source || source.count === 0) return;
    const folder = await pickFolder(await source.startFolder?.());
    if (!folder) return;
    const sep = folder.includes("\\") ? "\\" : "/";
    const title = `${source.name} - ${t("quotes.title").toLowerCase()}`;
    const heading = `${source.name}: ${t("quotes.title").toLowerCase()}`;
    const dir = `${folder}${sep}${safeName(title)}`;
    const items = source.build(source.hasPseudonyms && pseudonymise);
    // Numbers are needed to match the fragments to the quotes.
    const number = numbered || audio;
    const lines: QuoteLine[] = items.map((it, i) => {
      const label = number ? quoteLabel(i, items.length, lang) : undefined;
      return { ...it.line, label, audio: audio && label ? `${label}.${audioFormat}` : undefined };
    });
    try {
      setProgress({ done: 0, total: audio ? items.length : 0 });
      if (audio) {
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          const bleeps = source.hasPseudonyms && bleep ? it.spans : [];
          await api.exportClip(it.projectId, Math.max(0, it.s - margin), it.e + margin, `${dir}${sep}${lines[i].audio}`, voice === "original" ? null : voice, bleeps);
          setProgress({ done: i + 1, total: items.length });
        }
      }
      const docName = `${dir}${sep}${safeName(title)}.${format}`;
      const text = (s: string) => new TextEncoder().encode(s);
      const bytes =
        format === "docx"
          ? await quotesDocx(heading, lines, lang)
          : format === "csv"
            ? text(quotesCsv(lines, lang))
            : format === "md"
              ? text(quotesMarkdown(heading, lines, lang))
              : text(quotesText(heading, lines, lang));
      await api.writeFile(docName, bytes);
      onDone();
      useApp.getState().toast(t("export.saved", { path: dir }), "ok", { label: t("export.show"), run: () => void api.revealInFolder(docName) });
    } finally {
      setProgress(null);
    }
  };

  const bleeped = !!source?.hasPseudonyms && bleep;
  const form = (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label={t("export.format")}>
        {FORMATS.map((f) => (
          <button
            key={f.id}
            role="radio"
            aria-checked={format === f.id}
            onClick={() => setFormat(f.id)}
            className={cx(
              "flex items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors",
              format === f.id ? "border-accent bg-accent-soft" : "border-line hover:bg-surface-2",
            )}
          >
            <span className={format === f.id ? "text-accent" : "text-muted"}>{f.icon}</span>
            <span className="text-sm font-medium">{t(f.label)}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-surface-2 px-3.5 py-3">
        <Row label={t("quoteExport.numbered")} hint={t("quoteExport.numberedHint", { example: quoteLabel(0, 9, lang) })}>
          <Switch checked={numbered || audio} onChange={setNumbered} disabled={audio} label={t("quoteExport.numbered")} />
        </Row>
        <Row label={t("quoteExport.audio")} hint={t("quoteExport.audioHint")}>
          <Switch checked={audio} onChange={setAudio} label={t("quoteExport.audio")} />
        </Row>
        {audio && (
          <>
            <div className="flex items-center justify-between gap-3 text-sm">
              {t("quoteExport.audioFormat")}
              <div className="flex gap-2">
                <Select aria-label={t("quoteExport.audioFormat")} value={audioFormat} onChange={(e) => setAudioFormat(e.target.value as AudioFormat)} className="h-8 text-[13px]">
                  <option value="mp3">MP3</option>
                  <option value="m4a">M4A (AAC)</option>
                  <option value="wav">WAV</option>
                </Select>
                <Select aria-label={t("quoteExport.margin")} title={t("quoteExport.margin")} value={String(margin)} onChange={(e) => setMargin(Number(e.target.value))} className="h-8 text-[13px]">
                  {[0, 0.5, 1, 2].map((m) => (
                    <option key={m} value={m}>
                      {t("quoteExport.marginValue", { s: m.toLocaleString(lang === "nl" ? "nl-NL" : "en-GB") })}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-3 text-sm">
                {t("quoteExport.voice")}
                <Segmented
                  size="sm"
                  value={voice}
                  onChange={setVoice}
                  options={[
                    { value: "original", label: t("quoteExport.voiceOriginal") },
                    { value: "tv", label: t("quoteExport.voiceTv") },
                    { value: "whisper", label: t("quoteExport.voiceWhisper") },
                  ]}
                />
              </div>
              <span className="text-xs leading-relaxed text-muted">{t(`quoteExport.voiceHint_${voice}`)}</span>
            </div>
          </>
        )}
        {source?.hasPseudonyms && (
          <Row label={t("quoteExport.pseudonymiseText")} hint={t("quoteExport.pseudonymiseHint")}>
            <Switch checked={pseudonymise} onChange={setPseudonymise} label={t("quoteExport.pseudonymiseText")} />
          </Row>
        )}
        {source?.hasPseudonyms && audio && (
          <Row label={t("quoteExport.bleep")} hint={t("quoteExport.bleepHint")}>
            <Switch checked={bleep} onChange={setBleep} label={t("quoteExport.bleep")} />
          </Row>
        )}
      </div>

      {audio && (
        <Callout tone="warn" icon={<ShieldAlert />}>
          {t(
            bleeped
              ? voice === "original"
                ? "quoteExport.audioWarningBleeped"
                : "quoteExport.audioWarningSafe"
              : voice === "original"
                ? "quoteExport.audioWarning"
                : "quoteExport.audioWarningDisguised",
          )}
        </Callout>
      )}
    </div>
  );

  const busyLabel = progress && progress.total > 0 ? t("quoteExport.progress", { done: progress.done, total: progress.total }) : null;
  return { form, run, busy: progress !== null, busyLabel };
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>
        {label}
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
      {children}
    </label>
  );
}
