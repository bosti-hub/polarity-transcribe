// The editor's side panels: speakers, annotations, anonymisation and info.

import { ArrowUpToLine, Check, Play, Plus, Replace, ScanSearch, ShieldAlert, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Button, Callout, cx, IconButton, Kbd, TextInput } from "@/components/ui";
import { useT } from "@/lib/i18n";
import { formatDuration } from "@/lib/transcript";
import type { Candidate } from "@/lib/anonymize";
import type { AnonymizeRule, Quote, Speaker } from "@/lib/types";

const isMac = navigator.platform.toLowerCase().includes("mac");
export const MOD = isMac ? "⌘" : "Ctrl";

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
  onAdd,
  onRemove,
}: {
  defaults: string[];
  custom: string[];
  onInsert: (tag: string) => void;
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
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
      <div className="flex flex-col gap-1">
        {all.map((tag, i) => (
          <div key={tag} className="group flex items-center gap-1">
            <button
              // Keep the text cursor where it is: the tag goes there.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onInsert(tag)}
              className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-[13px] hover:bg-surface-3"
            >
              <span className="min-w-0 flex-1 truncate text-tag italic">{tag}</span>
              {i < 9 && (
                <span className="flex shrink-0 items-center gap-0.5 opacity-70">
                  <Kbd>{MOD}</Kbd>
                  <Kbd>{i + 1}</Kbd>
                </span>
              )}
            </button>
            {i >= defaults.length && (
              <IconButton label={t("common.remove")} size="sm" className="opacity-0 group-hover:opacity-100" onClick={() => onRemove(tag)}>
                <X className="size-3.5" />
              </IconButton>
            )}
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
    </div>
  );
}

// ------------------------------------------------------------------ anonymise

function RuleList({
  rules,
  counts,
  onChange,
  onPromote,
}: {
  rules: AnonymizeRule[];
  counts: number[];
  onChange: (rules: AnonymizeRule[]) => void;
  /** Move a rule to the study list (only for interview rules in a study). */
  onPromote?: (rule: AnonymizeRule) => void;
}) {
  const t = useT();
  const update = (i: number, patch: Partial<AnonymizeRule>) => onChange(rules.map((r, k) => (k === i ? { ...r, ...patch } : r)));
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
            <TextInput value={rule.replace} onChange={(e) => update(i, { replace: e.target.value })} placeholder={t("editor.replacePlaceholder")} aria-label={t("editor.replaceWith")} className="h-8" />
          </div>
          {rule.find.trim() && (
            <div className={cx("mt-1.5 pl-5 text-xs", (counts[i] ?? 0) > 0 ? "text-fg-2" : "text-muted")}>{t("editor.matches", { n: counts[i] ?? 0 })}</div>
          )}
        </div>
      ))}
      <Button variant="ghost" size="sm" className="-ml-1.5 self-start" icon={<Plus className="size-3.5" />} onClick={() => onChange([...rules, { find: "", replace: "" }])}>
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
  candidates,
  onStudyRules,
  onInterviewRules,
  onSuggest,
  onAddCandidate,
  onDismissCandidate,
  onApply,
}: {
  /** Null when the interview is not in a study. */
  studyName: string | null;
  studyRules: AnonymizeRule[];
  interviewRules: AnonymizeRule[];
  studyCounts: number[];
  interviewCounts: number[];
  /** Null until the user asks for suggestions. */
  candidates: Candidate[] | null;
  onStudyRules: (rules: AnonymizeRule[]) => void;
  onInterviewRules: (rules: AnonymizeRule[]) => void;
  onSuggest: () => void;
  onAddCandidate: (c: Candidate) => void;
  onDismissCandidate: (c: Candidate) => void;
  onApply: () => void;
}) {
  const t = useT();
  const total = [...studyCounts, ...interviewCounts].reduce((a, b) => a + b, 0);
  return (
    <div className="flex flex-col gap-5">
      <PanelTitle hint={t("editor.anonymizeHint")}>{t("editor.anonymize")}</PanelTitle>

      {studyName !== null && (
        <section>
          <h4 className="mb-2 truncate text-xs font-semibold text-fg-2">
            {t("editor.anonStudy")}: {studyName}
          </h4>
          <RuleList rules={studyRules} counts={studyCounts} onChange={onStudyRules} />
        </section>
      )}

      <section>
        {studyName !== null && <h4 className="mb-2 text-xs font-semibold text-fg-2">{t("editor.anonInterview")}</h4>}
        <RuleList
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

      <section>
        <Button variant="soft" size="sm" icon={<ScanSearch className="size-3.5" />} onClick={onSuggest}>
          {t("editor.anonSuggest")}
        </Button>
        {candidates && (
          <div className="mt-2.5">
            <h4 className="mb-1.5 text-xs font-semibold text-fg-2">{t("editor.anonSuggestions")}</h4>
            {candidates.length === 0 ? (
              <p className="text-xs text-muted">{t("editor.anonNoSuggestions")}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {candidates.slice(0, 40).map((c) => (
                  <li key={c.term} className="group flex items-center gap-1.5 rounded-lg px-1.5 py-1 hover:bg-surface-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{c.term}</span>
                      <span className="text-[11px] text-muted">
                        {t(`editor.anonKind_${c.kind}`)} · {c.count}×
                      </span>
                    </span>
                    <IconButton label={t("editor.anonDismiss")} size="sm" className="opacity-0 group-hover:opacity-100" onClick={() => onDismissCandidate(c)}>
                      <X className="size-3.5" />
                    </IconButton>
                    <IconButton label={t("editor.anonAdd")} size="sm" onClick={() => onAddCandidate(c)}>
                      <Plus className="size-3.5" />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <div className="flex flex-col gap-2">
        {total > 0 && <p className="text-xs text-fg-2">{t("editor.anonTotal", { n: total })}</p>}
        <Button variant="ghost" size="sm" className="-ml-1.5 self-start" icon={<Check className="size-3.5" />} disabled={total === 0} onClick={onApply}>
          {t("editor.applyPermanent", { n: total })}
        </Button>
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
}: {
  quotes: Quote[];
  speakerName: (id: string) => string;
  formatTime: (seconds: number) => string;
  onPlay: (q: Quote) => void;
  onChange: (quotes: Quote[]) => void;
}) {
  const t = useT();
  return (
    <div>
      <PanelTitle hint={t("quotes.hint", { key: `${MOD}+Q` })}>{t("quotes.title")}</PanelTitle>
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
}

export function InfoPanel({ words, duration, doubts, report }: { words: number; duration: number; doubts: number; report: Report | null }) {
  const t = useT();
  const rows: [string, string][] = [
    [t("editor.duration"), formatDuration(duration)],
    [t("editor.words", { n: "" }).trim(), words.toLocaleString()],
    [t("editor.doubtsLeft", { n: "" }).trim(), doubts.toLocaleString()],
  ];
  const shortcuts: [string, string[]][] = [
    [t("editor.scPlay"), ["Esc"]],
    [t("editor.scBack"), ["Alt", "←"]],
    [t("editor.scSlow"), ["Alt", "↓ ↑"]],
    [t("editor.scNextDoubt"), ["F8"]],
    [t("editor.confirmWord"), [MOD, "Enter"]],
    [t("editor.scLoop"), [MOD, "L"]],
    [t("editor.scTag"), [MOD, "1–9"]],
    [t("editor.scSplit"), ["Enter"]],
    [t("editor.scMerge"), ["Backspace"]],
    [t("editor.scFind"), [MOD, "F"]],
    [t("editor.scReviewed"), [MOD, "Shift", "Enter"]],
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
          {shortcuts.map(([label, keys]) => (
            <div key={label} className="flex items-center justify-between gap-2">
              <span className="text-fg-2">{label}</span>
              <span className="flex shrink-0 gap-0.5">
                {keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
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
