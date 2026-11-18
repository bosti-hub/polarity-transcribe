// The pseudonymisation check ("Find automatically"): finds names, dates, numbers and terms from
// the names list in the transcript and goes through them one by one, so the researcher decides
// about each of them: replace it with a pseudonym, keep it (not identifying), or come back to it
// later.

import { Check, ChevronLeft, ChevronRight, Play, ScanSearch, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Callout, IconButton, Progress, Switch, TextInput } from "@/components/ui";
import { findDetails, placeholderFor, type Detail, type DetailKind } from "@/lib/anonymize";
import { useT, type TKey } from "@/lib/i18n";
import type { AnonymizeRule, Transcript } from "@/lib/types";

/** A running check. Kept by the editor, so it survives switching side panels. */
export interface CheckSession {
  /** Terms (lower case) decided on or put off in this session. */
  seen: string[];
  replaced: number;
  kept: number;
  later: number;
  /** Decisions apply to the whole study (when the interview is in one). */
  studyWide: boolean;
}

const KIND_LABEL: Record<DetailKind, TKey> = {
  name: "check.kind_name",
  term: "check.kind_term",
  date: "check.kind_date",
  year: "check.kind_year",
  number: "check.kind_number",
  postcode: "check.kind_postcode",
  email: "check.kind_email",
  phone: "check.kind_phone",
};

const keyOf = (term: string) => term.trim().toLowerCase().replace(/\s+/g, " ");

export function DetailCheck({
  session,
  onSession,
  lang,
  inStudy,
  getTranscript,
  glossary,
  rules,
  keep,
  onReplace,
  onKeep,
  onShow,
  onListen,
}: {
  session: CheckSession | null;
  onSession: (s: CheckSession | null) => void;
  /** Interview language, for the suggested pseudonyms. */
  lang: "nl" | "en";
  inStudy: boolean;
  getTranscript: () => Transcript;
  glossary: string[];
  /** Interview and study rules together. */
  rules: AnonymizeRule[];
  /** Interview and study terms that were kept. */
  keep: string[];
  onReplace: (rule: AnonymizeRule, studyWide: boolean) => void;
  onKeep: (term: string, studyWide: boolean) => void;
  /** Highlight an occurrence of the term in the text: 0 the first, 1 / -1 the next / previous. */
  onShow: (term: string, direction: 0 | 1 | -1) => void;
  /** Play the audio around the highlighted occurrence. */
  onListen: () => void;
}) {
  const t = useT();
  const start = () => onSession({ seen: [], replaced: 0, kept: 0, later: 0, studyWide: inStudy });

  // What is left to decide on, recomputed as rules and kept terms change (and as the text is edited).
  const remaining = useMemo(() => {
    if (!session) return [];
    const seen = new Set(session.seen);
    return findDetails(getTranscript(), { glossary, rules, keep }).filter((d) => !seen.has(keyOf(d.term)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, glossary, rules, keep]);
  const current = remaining[0] ?? null;

  if (!session) {
    return (
      <section className="rounded-xl border border-line bg-surface-2 px-3 py-2.5">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <h4 className="text-[13px] font-medium">{t("check.title")}</h4>
            <p className="mt-0.5 text-xs leading-relaxed text-muted">{t("check.intro")}</p>
          </div>
          <Button size="sm" variant="secondary" icon={<ScanSearch className="size-3.5" />} onClick={start}>
            {t("check.start")}
          </Button>
        </div>
      </section>
    );
  }

  const total = session.seen.length + remaining.length;
  const decide = (patch: Partial<CheckSession>, term: string) =>
    onSession({ ...session, ...patch, seen: [...session.seen, keyOf(term)] });

  return (
    <section className="rounded-xl border border-accent/40 bg-surface p-3 ring-2 ring-accent/10">
      <div className="flex items-center gap-2">
        <h4 className="flex-1 text-[13px] font-semibold">{t("check.title")}</h4>
        <span className="text-xs tabular-nums text-muted">{current ? t("check.progress", { n: session.seen.length + 1, total }) : ""}</span>
        <IconButton label={t("check.stop")} size="sm" onClick={() => onSession(null)}>
          <X className="size-3.5" />
        </IconButton>
      </div>
      <Progress value={total ? session.seen.length / total : 1} className="mt-2" />
      {current ? (
        <CurrentDetail
          key={keyOf(current.term)}
          detail={current}
          lang={lang}
          rules={rules}
          inStudy={inStudy}
          studyWide={session.studyWide}
          onStudyWide={(v) => onSession({ ...session, studyWide: v })}
          onShow={onShow}
          onListen={onListen}
          onReplace={(rule) => {
            onReplace(rule, session.studyWide);
            decide({ replaced: session.replaced + 1 }, current.term);
          }}
          onKeep={() => {
            onKeep(current.term, session.studyWide);
            decide({ kept: session.kept + 1 }, current.term);
          }}
          onLater={() => decide({ later: session.later + 1 }, current.term)}
        />
      ) : (
        <div className="mt-3 flex flex-col gap-2.5">
          <Callout tone="ok" icon={<Check />}>
            {session.seen.length === 0
              ? t("check.none")
              : t("check.done", { replaced: session.replaced, kept: session.kept, later: session.later })}
          </Callout>
          <p className="text-xs leading-relaxed text-muted">{t("check.caution")}</p>
          <Button size="sm" variant="secondary" className="self-start" onClick={start}>
            {t("check.again")}
          </Button>
        </div>
      )}
    </section>
  );
}

function CurrentDetail({
  detail,
  lang,
  rules,
  inStudy,
  studyWide,
  onStudyWide,
  onShow,
  onListen,
  onReplace,
  onKeep,
  onLater,
}: {
  detail: Detail;
  lang: "nl" | "en";
  rules: AnonymizeRule[];
  inStudy: boolean;
  studyWide: boolean;
  onStudyWide: (v: boolean) => void;
  onShow: (term: string, direction: 0 | 1 | -1) => void;
  onListen: () => void;
  onReplace: (rule: AnonymizeRule) => void;
  onKeep: () => void;
  onLater: () => void;
}) {
  const t = useT();
  const [find, setFind] = useState(detail.term);
  const [replace, setReplace] = useState(() => placeholderFor(detail.kind, lang, rules));
  const replaceRef = useRef<HTMLInputElement>(null);

  // Show the first occurrence as soon as the term comes up, and put the cursor in the pseudonym.
  useEffect(() => {
    onShow(detail.term, 0);
    replaceRef.current?.focus();
    replaceRef.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.term]);

  const submit = () => {
    if (find.trim() && replace.trim()) onReplace({ find: find.trim(), replace: replace.trim() });
  };

  return (
    <div className="mt-3 flex flex-col gap-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[15px] font-semibold">{detail.term}</span>
            <Badge tone="accent">{t(KIND_LABEL[detail.kind])}</Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted">{t("check.count", { n: detail.count })}</p>
        </div>
        <div className="flex shrink-0 items-center">
          <IconButton label={t("editor.prevMatch")} size="sm" onClick={() => onShow(find, -1)}>
            <ChevronLeft className="size-3.5" />
          </IconButton>
          <IconButton label={t("editor.nextMatch")} size="sm" onClick={() => onShow(find, 1)}>
            <ChevronRight className="size-3.5" />
          </IconButton>
          <IconButton label={t("check.listen")} size="sm" onClick={onListen}>
            <Play className="size-3.5" />
          </IconButton>
        </div>
      </div>

      <form
        className="flex flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextInput value={find} onChange={(e) => setFind(e.target.value)} aria-label={t("editor.find")} className="h-8" />
        <TextInput
          ref={replaceRef}
          value={replace}
          onChange={(e) => setReplace(e.target.value)}
          aria-label={t("editor.replaceWith")}
          placeholder={t("editor.replacePlaceholder")}
          className="h-8"
        />
        {inStudy && (
          <label className="mt-0.5 flex items-center justify-between gap-3 text-xs text-fg-2">
            <span>{t("check.studyWide")}</span>
            <Switch checked={studyWide} onChange={onStudyWide} label={t("check.studyWide")} />
          </label>
        )}
        <div className="mt-1 flex items-center gap-1.5">
          <Button type="submit" size="sm" variant="primary" disabled={!find.trim() || !replace.trim()}>
            {t("check.replace")}
          </Button>
          <Button type="button" size="sm" variant="secondary" title={t("check.keepHint")} onClick={onKeep}>
            {t("check.keep")}
          </Button>
          <button type="button" onClick={onLater} className="ml-auto shrink-0 rounded px-1 text-[13px] font-medium text-fg-2 hover:text-fg">
            {t("check.later")}
          </button>
        </div>
      </form>
    </div>
  );
}
