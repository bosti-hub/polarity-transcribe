// The editor's side panels: speakers, annotations, anonymisation and info.

import { ArrowUpToLine, ChevronLeft, ChevronRight, Download, Play, Plus, Quote as QuoteIcon, Replace, RotateCcw, ShieldAlert, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button, Callout, cx, IconButton, Kbd, Switch, TextInput } from "@/components/ui";
import type { TagDrag } from "@/editor/tagDrag";
import { useT } from "@/lib/i18n";
import { formatClock, formatDuration } from "@/lib/transcript";
import type { AnonymizeRule, Quote, Speaker } from "@/lib/types";

export { MOD } from "@/lib/keys";
import { MOD, orderKeys, shortcutLabel } from "@/lib/keys";

function PanelTitle({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="mb-3">
      <h3 className="text-[13px] font-semibold">{children}</h3>
      {hint && <p className="mt-0.5 text-xs leading-relaxed text-muted">{hint}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ speakers

export function SpeakersPanel({
  speakers,
  onRename,
  onAdd,
}: {
  speakers: Speaker[];
  onRename: (id: string, name: string) => void;
  onAdd: () => void;
}) {
  const t = useT();
  return (
    <div>
      <PanelTitle hint={t("editor.speakersHint")}>{t("editor.speakers")}</PanelTitle>
      <div className="flex flex-col gap-2">
        {speakers.map((sp, i) => (
          <SpeakerRow key={sp.id} speaker={sp} index={i} onRename={onRename} />
        ))}
      </div>
      <Button variant="ghost" size="sm" className="mt-2 -ml-1.5" icon={<Plus className="size-3.5" />} onClick={onAdd}>
        {t("editor.newSpeaker")}
      </Button>
    </div>
  );
}

function SpeakerRow({ speaker, index, onRename }: { speaker: Speaker; index: number; onRename: (id: string, name: string) => void }) {
  const [value, setValue] = useState(speaker.name);
  const commit = () => {
    const name = value.trim();
    if (name && name !== speaker.name) onRename(speaker.id, name);
    else setValue(speaker.name);
  };
  return (
    <div className="flex items-center gap-2">
      <span className="size-2.5 shrink-0 rounded-full" style={{ background: `var(--sp${(index % 4) + 1})` }} />
      <TextInput
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setValue(speaker.name);
        }}
        className="h-8"
        maxLength={40}
      />
    </div>
  );
}

// ------------------------------------------------------------------ annotations

export function TagsPanel({
  defaults,
  custom,
  onInsert,
  drag,
  onAdd,
  onRemove,
  onRestoreDefaults,
}: {
  /** Built-in labels still in the list. */
  defaults: string[];
  custom: string[];
  onInsert: (tag: string) => void;
  /** Dragging an annotation into the text. */
  drag?: TagDrag;
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
  /** Present when built-in labels were removed: puts them back. */
  onRestoreDefaults?: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const all = [...defaults, ...custom];
  const add = () => {
    const core = draft.trim().replace(/^\[|\]$/g, "").trim();
    if (!core) return;
    const tag = `[${core}]`;
    if (!all.includes(tag)) onAdd(tag);
    setDraft("");
  };
  return (
    <div>
      <PanelTitle>{t("editor.tags")}</PanelTitle>
      <p className="-mt-1 mb-2 text-xs leading-relaxed text-muted">{all.length ? t("editor.tagsHint") : t("editor.tagsEmpty")}</p>
      <div className="flex flex-col gap-1">
        {all.map((tag, i) => (
          <div key={tag} className="group flex items-center gap-1">
            <button
              // Keep the text cursor where it is: a click inserts the tag there. Dragging puts it
              // where it is dropped (src/editor/tagDrag.ts).
              onMouseDown={(e) => e.preventDefault()}
              onPointerDown={(e) => drag?.start(tag, e)}
              onClick={() => !drag?.wasDrag() && onInsert(tag)}
              className="flex h-8 min-w-0 flex-1 cursor-grab items-center gap-2 rounded-lg px-2 text-left text-[13px] hover:bg-surface-3 active:cursor-grabbing"
            >
              <span className="min-w-0 flex-1 truncate text-tag italic">{tag}</span>
              {i < 9 && (
                <span className="flex shrink-0 items-center gap-0.5 opacity-70">
                  <Kbd>{MOD}</Kbd>
                  <Kbd>{i + 1}</Kbd>
                </span>
              )}
            </button>
            <IconButton label={t("common.remove")} size="sm" onClick={() => onRemove(tag)}>
              <Trash2 className="size-3.5 text-danger" />
            </IconButton>
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-1.5">
        <TextInput
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder={t("editor.tagPlaceholder")}
          aria-label={t("editor.addTag")}
          className="h-8"
          maxLength={40}
        />
        <IconButton label={t("editor.addTag")} size="sm" className="size-8" onClick={add} disabled={!draft.trim()}>
          <Plus className="size-4" />
        </IconButton>
      </div>
      {onRestoreDefaults && (
        <Button variant="ghost" size="sm" className="mt-2 -ml-1.5" icon={<RotateCcw className="size-3.5" />} onClick={onRestoreDefaults}>
          {t("editor.restoreTags")}
        </Button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ anonymise

function RuleList({
  rules,
  counts,
  onChange,
  onPromote,
  onJump,
  selection,
}: {
  rules: AnonymizeRule[];
  counts: number[];
  onChange: (rules: AnonymizeRule[]) => void;
  /** Select the previous or next place in the text where the term occurs. */
  onJump: (find: string, direction: 1 | -1) => void;
  /** Move a rule to the study list (only for interview rules in a study). */
  onPromote?: (rule: AnonymizeRule) => void;
  /** The words selected in the text (a few at most), to start a new rule with; "" when none. */
  selection: () => string;
}) {
  const t = useT();
  const update = (i: number, patch: Partial<AnonymizeRule>) => onChange(rules.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  // A new rule that already has its search term: the cursor goes straight to the pseudonym.
  const [focusReplace, setFocusReplace] = useState<number | null>(null);
  const addRule = () => {
    const find = selection();
    const known = find && rules.some((r) => r.find.trim().toLowerCase() === find.toLowerCase());
    onChange([...rules, { find: known ? "" : find, replace: "" }]);
    setFocusReplace(find && !known ? rules.length : null);
  };
  return (
    <div className="flex flex-col gap-2">
      {rules.map((rule, i) => (
        <div key={i} className="rounded-xl border border-line bg-surface-2 p-2">
          <div className="flex items-center gap-1.5">
            <TextInput value={rule.find} onChange={(e) => update(i, { find: e.target.value })} placeholder={t("editor.findPlaceholder")} aria-label={t("editor.find")} className="h-8" />
            {onPromote && rule.find.trim() && (
              <IconButton label={t("editor.anonToStudy")} size="sm" onClick={() => onPromote(rule)}>
                <ArrowUpToLine className="size-3.5" />
              </IconButton>
            )}
            <IconButton label={t("common.remove")} size="sm" onClick={() => onChange(rules.filter((_, k) => k !== i))}>
              <Trash2 className="size-3.5" />
            </IconButton>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <Replace className="size-3.5 shrink-0 text-muted" />
            <TextInput
              value={rule.replace}
              onChange={(e) => update(i, { replace: e.target.value })}
              placeholder={t("editor.replacePlaceholder")}
              aria-label={t("editor.replaceWith")}
              className="h-8"
              autoFocus={focusReplace === i}
              onFocus={() => focusReplace === i && setFocusReplace(null)}
            />
          </div>
          {rule.find.trim() && (
            <div className={cx("mt-1 flex items-center gap-1 pl-5 text-xs", (counts[i] ?? 0) > 0 ? "text-fg-2" : "text-muted")}>
              <span className="flex-1">{t("editor.matches", { n: counts[i] ?? 0 })}</span>
              {(counts[i] ?? 0) > 0 && (
                <>
                  <IconButton label={t("editor.prevMatch")} size="sm" onClick={() => onJump(rule.find, -1)}>
                    <ChevronLeft className="size-3.5" />
                  </IconButton>
                  <IconButton label={t("editor.nextMatch")} size="sm" onClick={() => onJump(rule.find, 1)}>
                    <ChevronRight className="size-3.5" />
                  </IconButton>
                </>
              )}
            </div>
          )}
        </div>
      ))}
      <Button variant="ghost" size="sm" className="-ml-1.5 self-start" icon={<Plus className="size-3.5" />} onClick={addRule}>
        {t("editor.addRule")}
      </Button>
    </div>
  );
}

export function AnonymizePanel({
  studyName,
  studyRules,
  interviewRules,
  studyCounts,
  interviewCounts,
  onStudyRules,
  onInterviewRules,
  showInText,
  onShowInText,
  onJump,
  selection,
  check,
}: {
  /** Null when the interview is not in a study. */
  studyName: string | null;
  studyRules: AnonymizeRule[];
  interviewRules: AnonymizeRule[];
  studyCounts: number[];
  interviewCounts: number[];
  onStudyRules: (rules: AnonymizeRule[]) => void;
  onInterviewRules: (rules: AnonymizeRule[]) => void;
  /** Whether pseudonyms are shown in the text instead of the originals. */
  showInText: boolean;
  onShowInText: (on: boolean) => void;
  onJump: (find: string, direction: 1 | -1) => void;
  /** The words selected in the text, to start a new rule with. */
  selection: () => string;
  /** The pseudonymisation check (finds names and goes through them). */
  check?: React.ReactNode;
}) {
  const t = useT();
  const total = [...studyCounts, ...interviewCounts].reduce((a, b) => a + b, 0);
  return (
    <div className="flex flex-col gap-5">
      <PanelTitle hint={t("editor.anonymizeHint")}>{t("editor.anonymize")}</PanelTitle>

      <label className="-mt-2 flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 px-3 py-2">
        <span className="text-[13px]">{t("editor.anonShowInText")}</span>
        <Switch checked={showInText} onChange={onShowInText} label={t("editor.anonShowInText")} />
      </label>

      {check}

      {studyName !== null && (
        <section>
          <h4 className="mb-2 truncate text-xs font-semibold text-fg-2">
            {t("editor.anonStudy")}: {studyName}
          </h4>
          <RuleList rules={studyRules} counts={studyCounts} onChange={onStudyRules} onJump={onJump} selection={selection} />
        </section>
      )}

      <section>
        {studyName !== null && <h4 className="mb-2 text-xs font-semibold text-fg-2">{t("editor.anonInterview")}</h4>}
        <RuleList
          onJump={onJump}
          selection={selection}
          rules={interviewRules}
          counts={interviewCounts}
          onChange={onInterviewRules}
          onPromote={
            studyName !== null
              ? (rule) => {
                  onStudyRules([...studyRules, rule]);
                  onInterviewRules(interviewRules.filter((r) => r !== rule));
                }
              : undefined
          }
        />
      </section>


      <div className="flex flex-col gap-2">
        {total > 0 && <p className="text-xs text-fg-2">{t("editor.anonTotal", { n: total })}</p>}
        <Callout tone="warn" icon={<ShieldAlert />}>
          {t("editor.audioNote")}
        </Callout>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ quotes

export function QuotesPanel({
  quotes,
  speakerName,
  formatTime,
  onPlay,
  onChange,
  onAdd,
  onExport,
}: {
  quotes: Quote[];
  speakerName: (id: string) => string;
  formatTime: (seconds: number) => string;
  onPlay: (q: Quote) => void;
  onChange: (quotes: Quote[]) => void;
  /** Save the selected text as a quote (as the shortcut does). */
  onAdd: () => void;
  onExport: () => void;
}) {
  const t = useT();
  return (
    <div>
      <PanelTitle hint={t("quotes.hint", { key: shortcutLabel(`${MOD}+U`) })}>{t("quotes.title")}</PanelTitle>
      <div className="mb-3 flex flex-wrap gap-2">
        {/* Keeps the selection in the transcript: the button must not take the focus on press. */}
        <Button variant="secondary" size="sm" icon={<QuoteIcon className="size-3.5" />} onMouseDown={(e) => e.preventDefault()} onClick={onAdd}>
          {t("quotes.add")}
          <Kbd>{shortcutLabel(`${MOD}+U`)}</Kbd>
        </Button>
        {quotes.length > 0 && (
          <Button variant="secondary" size="sm" icon={<Download className="size-3.5" />} onClick={onExport}>
            {t("quotes.exportN", { n: quotes.length })}
          </Button>
        )}
      </div>
      {quotes.length === 0 ? (
        <p className="text-xs leading-relaxed text-muted">{t("quotes.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {quotes.map((q) => (
            <QuoteRow
              key={q.id}
              quote={q}
              meta={`${speakerName(q.speaker)} · ${formatTime(q.s)}`}
              onPlay={() => onPlay(q)}
              onNote={(note) => onChange(quotes.map((x) => (x.id === q.id ? { ...x, note } : x)))}
              onDelete={() => onChange(quotes.filter((x) => x.id !== q.id))}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function QuoteRow({ quote, meta, onPlay, onNote, onDelete }: { quote: Quote; meta: string; onPlay: () => void; onNote: (note: string) => void; onDelete: () => void }) {
  const t = useT();
  const [note, setNote] = useState(quote.note);
  return (
    <li className="group rounded-xl border border-line bg-surface-2 p-2.5">
      <p className="line-clamp-5 text-[13px] leading-relaxed italic">“{quote.text}”</p>
      <div className="mt-1.5 flex items-center gap-1">
        <button onClick={onPlay} className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs text-muted hover:text-accent">
          <Play className="size-3 shrink-0" />
          <span className="truncate">{meta}</span>
        </button>
        <IconButton label={t("common.remove")} size="sm" className="opacity-0 group-hover:opacity-100" onClick={onDelete}>
          <Trash2 className="size-3.5" />
        </IconButton>
      </div>
      <TextInput
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => note !== quote.note && onNote(note)}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        placeholder={t("quotes.notePlaceholder")}
        aria-label={t("quotes.note")}
        className="mt-1.5 h-7 text-xs"
      />
    </li>
  );
}

// ------------------------------------------------------------------ info

export interface Report {
  method?: "own_mic" | "delay" | "voice" | "none";
  sync?: { offset: number; driftPpm: number } | null;
  bleed?: { separationDb: number; separable: boolean } | null;
  delay?: { separationMs: number; separable: boolean; seatingChanges?: number } | null;
  languageSwitch?: { from: "nl" | "en"; to: "nl" | "en"; probability: number } | null;
  /** Passages with suspiciously few recognised words (transcript timeline). */
  sparse?: { start: number; end: number }[];
}

/** "0:41–1:00" buttons that go to each passage with suspiciously few words. */
export function SparseLinks({ spans, onJump }: { spans: { start: number; end: number }[]; onJump: (seconds: number) => void }) {
  return (
    <span className="flex flex-wrap gap-1">
      {spans.map((s) => (
        <button
          key={s.start}
          onClick={() => onJump(s.start)}
          className="tabular rounded-md bg-surface px-1.5 py-0.5 text-xs font-medium text-accent shadow-card hover:bg-surface-3"
        >
          {formatClock(s.start)}–{formatClock(s.end)}
        </button>
      ))}
    </span>
  );
}

export function InfoPanel({
  words,
  duration,
  doubts,
  report,
  onJump,
}: {
  words: number;
  duration: number;
  doubts: number;
  report: Report | null;
  onJump: (seconds: number) => void;
}) {
  const t = useT();
  const rows: [string, string][] = [
    [t("editor.duration"), formatDuration(duration)],
    [t("editor.words", { n: "" }).trim(), words.toLocaleString()],
    [t("editor.doubtsLeft", { n: "" }).trim(), doubts.toLocaleString()],
  ];
  // Each entry lists alternatives; each alternative is a list of keys pressed together.
  const shortcuts: [string, string[][]][] = [
    [t("editor.scPlay"), [["Esc"], ["⏯"]]],
    [t("editor.scBack"), [["Alt", "←"]]],
    [t("editor.scSlow"), [["Alt", "↓ ↑"]]],
    [t("editor.scNextDoubt"), [["F8"]]],
    [t("editor.confirmWord"), [[MOD, "Enter"]]],
    [t("editor.scLoop"), [[MOD, "L"]]],
    [t("editor.scTag"), [[MOD, "1–9"]]],
    [t("quotes.add"), [[MOD, "U"]]],
    [t("editor.scSplit"), [["Enter"]]],
    [t("editor.scMerge"), [["Backspace"]]],
    [t("editor.scFind"), [[MOD, "F"]]],
    [t("editor.scReviewed"), [[MOD, "Shift", "Enter"]]],
  ];
  return (
    <div>
      <PanelTitle>{t("editor.info")}</PanelTitle>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg-2 first-letter:uppercase">{k}</dt>
            <dd className="tabular text-right font-medium">{v}</dd>
          </div>
        ))}
      </dl>

      {report?.languageSwitch && (
        <div className="mt-4 rounded-lg bg-accent-soft px-2.5 py-2 text-xs leading-relaxed text-fg">
          {t("editor.languageSwitched", {
            to: t(report.languageSwitch.to === "nl" ? "common.dutch" : "common.english"),
            from: t(report.languageSwitch.from === "nl" ? "common.dutch" : "common.english"),
          })}
        </div>
      )}
      {report?.sparse && report.sparse.length > 0 && (
        <div className="mt-4 flex flex-col gap-1.5 rounded-lg bg-warn-soft px-2.5 py-2 text-xs leading-relaxed text-fg">
          <span>{t("editor.sparseText")}</span>
          <SparseLinks spans={report.sparse} onJump={onJump} />
        </div>
      )}
      {report && (report.sync || report.method !== "none" || report.bleed) && (
        <div className="mt-5">
          <PanelTitle>{t("editor.quality")}</PanelTitle>
          <div className="flex flex-col gap-2 text-xs leading-relaxed text-fg-2">
            {report.sync && (
              <p>{t("editor.syncInfo", { offset: `${report.sync.offset.toFixed(3)} s`, drift: report.sync.driftPpm.toFixed(1) })}</p>
            )}
            {report.method === "own_mic" && report.bleed && <p>{t("editor.bleedGood", { db: report.bleed.separationDb.toFixed(0) })}</p>}
            {report.method === "delay" && <p>{t("editor.methodDelay")}</p>}
            {report.method === "voice" && <p>{t("editor.methodVoice")}</p>}
            {report.method === "delay" && (report.delay?.seatingChanges ?? 0) > 0 && (
              <p className="rounded-lg bg-warn-soft px-2.5 py-2 text-fg">{t("editor.seatingChanged")}</p>
            )}
            {report.method === "none" && report.bleed && <p>{t("editor.bleedPoor", { db: report.bleed.separationDb.toFixed(0) })}</p>}
          </div>
        </div>
      )}

      <div className="mt-5">
        <PanelTitle>{t("editor.shortcuts")}</PanelTitle>
        <div className="flex flex-col gap-1.5 text-xs">
          {shortcuts.map(([label, alternatives]) => (
            <div key={label} className="flex items-center justify-between gap-2">
              <span className="text-fg-2">{label}</span>
              <span className="flex shrink-0 items-center gap-0.5">
                {alternatives.map((keys, i) => (
                  <span key={i} className="contents">
                    {i > 0 && <span className="px-1 text-muted">{t("common.or")}</span>}
                    {orderKeys(keys).map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </span>
                ))}
              </span>
            </div>
          ))}
          <p className="mt-1 text-muted">{t("editor.scClick")}</p>
        </div>
      </div>
    </div>
  );
}
