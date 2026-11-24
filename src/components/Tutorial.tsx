// The tour: three short slides on how to work, shown at startup until switched off and reopened
// from the start screen's sidebar, the manual or Settings. Each slide has a small drawing of the
// part of the app it is about, built from the app's own colours so it follows the theme.

import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FileArchive,
  FileAudio,
  GripVertical,
  MousePointer2,
  PenLine,
  Quote,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import { Dialog as RDialog } from "radix-ui";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { MOD, shortcutLabel } from "@/lib/keys";
import { useApp } from "@/lib/store";
import { tutorialText, type TutorialText } from "@/lib/tutorial";
import { Button, cx, Kbd } from "./ui";

const SLIDES = ["workflow", "speakers", "finish"] as const;

/** "press {Mod+U}" → the text with the shortcut drawn as a key, in the platform's notation. */
function withKeys(text: string): ReactNode[] {
  return text.split(/\{([^}]+)\}/).map((part, i) => (i % 2 === 1 ? <Kbd key={i}>{shortcutLabel(part.replace(/\bMod\b/g, MOD))}</Kbd> : part));
}

export function Tutorial() {
  const t = useT();
  const open = useApp((s) => s.tutorialOpen);
  const setOpen = useApp((s) => s.setTutorialOpen);
  const lang = useApp((s) => s.settings.uiLanguage);
  const showAtStart = useApp((s) => s.settings.showTutorial);
  const updateSettings = useApp((s) => s.updateSettings);
  const [index, setIndex] = useState(0);
  const nextRef = useRef<HTMLButtonElement>(null);

  // Every time it opens, start at the first slide.
  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  const text = tutorialText(lang);
  const id = SLIDES[index];
  const slide = text[id];
  const last = index === SLIDES.length - 1;
  const goTo = (n: number) => {
    const to = Math.max(0, Math.min(SLIDES.length - 1, n));
    setIndex(to);
    // The Back button hides on the first slide; keep the focus on a button that stays.
    if (to === 0) nextRef.current?.focus();
  };

  let art: ReactNode;
  switch (id) {
    case "workflow":
      art = <WorkflowArt text={text.workflow} />;
      break;
    case "speakers":
      art = <SpeakersArt text={text.speakers} />;
      break;
    case "finish":
      art = <FinishArt text={text.finish} />;
      break;
  }

  return (
    <RDialog.Root open={open} onOpenChange={setOpen}>
      <RDialog.Portal>
        <RDialog.Overlay className="anim-fade fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
        <RDialog.Content
          style={{ width: 640 }}
          className="anim-pop fixed top-1/2 left-1/2 z-50 flex max-h-[94vh] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-modal"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            nextRef.current?.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") goTo(index + 1);
            else if (e.key === "ArrowLeft") goTo(index - 1);
          }}
        >
          <div className="relative h-[232px] shrink-0 overflow-hidden border-b border-line bg-surface-2">
            <div key={id} className="anim-fade flex h-full items-center justify-center px-8 pb-5">
              {art}
            </div>
            <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-1.5">
              {SLIDES.map((s, n) => (
                <button
                  key={s}
                  aria-label={t("tutorial.slide", { n: n + 1, total: SLIDES.length })}
                  aria-current={n === index ? "step" : undefined}
                  onClick={() => goTo(n)}
                  className={cx("h-1.5 rounded-full transition-all duration-300", n === index ? "w-6 bg-accent" : "w-1.5 bg-line-strong hover:bg-muted")}
                />
              ))}
            </div>
            <RDialog.Close asChild>
              <button aria-label={t("common.close")} className="absolute top-3 right-3 rounded-lg p-1.5 text-muted hover:bg-surface-3 hover:text-fg">
                <X className="size-4" />
              </button>
            </RDialog.Close>
          </div>

          <div key={`text-${id}`} className="anim-fade min-h-[248px] flex-1 overflow-y-auto px-7 pt-5 pb-3">
            <div className="flex items-baseline gap-2 text-xs">
              <span className="font-semibold text-accent">{slide.kicker}</span>
              <span className="text-muted tabular-nums">
                {index + 1}/{SLIDES.length}
              </span>
            </div>
            <RDialog.Title className="mt-1 text-[19px] font-semibold tracking-tight text-balance">{slide.title}</RDialog.Title>
            <RDialog.Description asChild>
              <ul className="mt-3 flex flex-col gap-2 text-[13.5px] leading-relaxed text-fg-2">
                {slide.points.map((p) => (
                  <li key={p} className="flex gap-2.5">
                    <span className="mt-[9px] size-1 shrink-0 rounded-full bg-muted" aria-hidden />
                    <span className="min-w-0">{withKeys(p)}</span>
                  </li>
                ))}
              </ul>
            </RDialog.Description>
          </div>

          <div className="flex shrink-0 items-center gap-3 border-t border-line px-7 py-4">
            <div className="min-w-0 flex-1">
              <label className="flex w-fit cursor-pointer items-center gap-2 text-[13px] text-fg-2 select-none">
                <input
                  type="checkbox"
                  checked={!showAtStart}
                  onChange={(e) => updateSettings({ showTutorial: !e.target.checked })}
                  className="size-4 accent-[var(--accent)]"
                />
                {t("tutorial.dontShow")}
              </label>
              {!showAtStart && <div className="anim-fade mt-0.5 pl-6 text-xs text-muted">{t("tutorial.findLater")}</div>}
            </div>
            <Button variant="ghost" className={cx(index === 0 && "invisible")} onClick={() => goTo(index - 1)}>
              <ArrowLeft className="size-4" />
              {t("common.back")}
            </Button>
            <Button ref={nextRef} variant="primary" onClick={() => (last ? setOpen(false) : goTo(index + 1))}>
              {last ? t("tutorial.start") : t("common.next")}
              <ArrowRight className="size-4" />
            </Button>
          </div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

// ------------------------------------------------------------------ drawings

/** Speaker colours as in the transcript (--sp1, --sp2, …). */
const spColor = (sp: number): CSSProperties => ({ color: `var(--sp${sp})` });
const spLine = (sp: number): CSSProperties => ({ borderColor: `color-mix(in srgb, var(--sp${sp}) 28%, transparent)` });

/** One turn as the editor draws it: speaker name on the left, text with a coloured rule. */
function Turn({ sp, name, pointed, children }: { sp: number; name: string; pointed?: boolean; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-x-3 py-1">
      <div className="flex flex-col items-end">
        <span
          className="flex max-w-full items-center gap-0.5 rounded-md px-1.5 text-[12px] leading-[1.8] font-semibold"
          style={{ ...spColor(sp), background: pointed ? `color-mix(in srgb, var(--sp${sp}) 12%, transparent)` : undefined }}
        >
          <span className="truncate">{name}</span>
          {pointed && <ChevronDown className="size-3 shrink-0" />}
        </span>
      </div>
      <p className="border-l-2 pl-3 text-[13.5px] leading-[1.8] text-fg" style={spLine(sp)}>
        {children}
      </p>
    </div>
  );
}

/** A mouse pointer resting on what it points at. */
function Pointer({ className }: { className?: string }) {
  return <MousePointer2 aria-hidden className={cx("pointer-events-none absolute size-[18px] fill-fg text-surface drop-shadow-sm", className)} />;
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Plays a drawing's steps in a loop: returns the current step, which lasts `durations[step]` ms.
 * With reduced motion it stays on `still`, the step that tells the whole story.
 */
function useSteps(durations: number[], still: number): number {
  const [step, setStep] = useState(() => (reducedMotion() ? still : 0));
  useEffect(() => {
    if (reducedMotion()) return;
    const timer = setTimeout(() => setStep((s) => (s + 1) % durations.length), durations[step]);
    return () => clearTimeout(timer);
  }, [step, durations]);
  return step;
}

/** Counts up from 0 every `ms` while mounted (with reduced motion: stays at `still`). */
function useTicker(ms: number, still: number): number {
  const [n, setN] = useState(() => (reducedMotion() ? still : 0));
  useEffect(() => {
    if (reducedMotion()) return;
    const timer = setInterval(() => setN((v) => v + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return n;
}

/** A made-up but natural-looking waveform. */
const WAVE = Array.from({ length: 64 }, (_, i) => {
  const v = Math.abs(Math.sin(i * 0.9) * 0.55 + Math.sin(i * 0.37 + 1) * 0.35 + Math.sin(i * 2.3) * 0.15);
  return 0.18 + Math.min(1, v) * 0.82;
});

function Wave({ played, className }: { played: number; className?: string }) {
  return (
    <div className={cx("flex h-9 items-center justify-between", className)}>
      {WAVE.map((h, i) => (
        <span
          key={i}
          className={cx("w-[3px] shrink-0 rounded-full transition-colors duration-200", i / WAVE.length < played ? "bg-accent" : "bg-line-strong")}
          style={{ height: `${h * 100}%` }}
        />
      ))}
    </div>
  );
}

const WORKFLOW_STEPS = [800, 2600, 4400, 2400];

function WorkflowArt({ text }: { text: TutorialText["workflow"] }) {
  const icons = [<FileAudio key="a" />, <AudioLines key="b" />, <PenLine key="c" />, <Download key="d" />];
  const step = useSteps(WORKFLOW_STEPS, 2);
  let stage: ReactNode;
  switch (step) {
    case 0:
      stage = <AddStage text={text} />;
      break;
    case 1:
      stage = <TranscribeStage text={text} />;
      break;
    case 2:
      stage = <CheckStage text={text} />;
      break;
    default:
      stage = <ExportStage text={text} />;
  }
  return (
    <div className="flex w-full max-w-[576px] flex-col gap-3" aria-hidden>
      <div className="flex items-center justify-center gap-1">
        {text.steps.map((title, i) => (
          <Fragment key={title}>
            {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted" />}
            <span
              className={cx(
                "flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold whitespace-nowrap transition-colors duration-300 [&>svg]:size-3.5",
                i === step
                  ? "border-accent bg-accent text-accent-fg shadow-pop"
                  : i < step
                    ? "border-line bg-surface text-fg-2"
                    : "border-line bg-surface/60 text-muted",
              )}
            >
              {i < step ? <Check className="text-ok" /> : icons[i]}
              {title}
            </span>
          </Fragment>
        ))}
      </div>
      <div className="relative h-[122px] overflow-hidden rounded-xl border border-line bg-surface px-5 shadow-card">
        <div key={step} className="anim-fade flex h-full flex-col justify-center">
          {stage}
        </div>
      </div>
    </div>
  );
}

function AddStage({ text }: { text: TutorialText["workflow"] }) {
  return (
    <div className="flex justify-center">
      <div className="anim-drop flex items-center gap-3 rounded-xl border border-line bg-surface-2 py-2.5 pr-5 pl-3 shadow-pop">
        <span className="flex size-10 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <FileAudio className="size-5" />
        </span>
        <div>
          <div className="text-[13px] font-semibold">{text.file}</div>
          <div className="text-[11.5px] text-muted">{text.length}</div>
        </div>
        <span className="relative self-end">
          <Pointer className="-top-3 -left-3" />
        </span>
      </div>
    </div>
  );
}

function TranscribeStage({ text }: { text: TutorialText["workflow"] }) {
  const n = useTicker(240, text.words.length);
  const shown = Math.min(n, text.words.length);
  return (
    <div className="flex flex-col gap-2">
      <Wave played={shown / text.words.length} />
      <p className="h-6 text-[14px] text-fg">
        {text.words.slice(0, shown).map((w, i) => (
          <span key={i} className="anim-rise inline-block">
            {w}&nbsp;
          </span>
        ))}
      </p>
    </div>
  );
}

function CheckStage({ text }: { text: TutorialText["workflow"] }) {
  const { words } = text;
  // Rests on the first word a moment (the click), then plays through.
  const n = useTicker(360, 3);
  const playing = Math.max(0, Math.min(words.length - 1, n - 2));
  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Wave played={(playing + 0.5) / words.length} />
        <span
          className="absolute -inset-y-1 w-0.5 rounded-full bg-accent transition-[left] duration-300 ease-linear"
          style={{ left: `${((playing + 0.5) / words.length) * 100}%` }}
        />
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[14px] text-fg">
          {words.map((w, i) => (
            <Fragment key={i}>
              <span
                className="relative rounded-[3px] transition-colors duration-100"
                style={i === playing ? { background: "var(--play)", boxShadow: "0 0 0 2px var(--play)" } : undefined}
              >
                {w}
                {i === 0 && <Pointer className="top-[60%] left-[50%]" />}
              </span>{" "}
            </Fragment>
          ))}
        </p>
        <span className="shrink-0 text-[11px] font-medium text-accent">{text.synced}</span>
      </div>
    </div>
  );
}

function ExportStage({ text }: { text: TutorialText["workflow"] }) {
  return (
    <div className="flex items-center justify-center gap-2.5">
      {text.exports.map((name, i) => (
        <span
          key={name}
          className="anim-drop flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] font-semibold shadow-card"
          style={{ animationDelay: `${i * 160}ms` }}
        >
          <Download className="size-3.5 text-accent" />
          {name}
        </span>
      ))}
    </div>
  );
}

/**
 * Steps of the speakers drawing: 0 plain, 1 interjection selected, 2 "Said by…" shows,
 * 3 menu with the interviewer, 4 interjection given to the interviewer, 5 notation picked up,
 * 6 dragged into the text, 7 dropped.
 */
const SPEAKER_STEPS = [900, 800, 900, 1000, 1100, 500, 900, 2600];

function SpeakersArt({ text }: { text: TutorialText["speakers"] }) {
  const step = useSteps(SPEAKER_STEPS, 7);
  const boxRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLSpanElement>(null);
  const dropRef = useRef<HTMLSpanElement>(null);
  const [path, setPath] = useState<{ from: [number, number]; to: [number, number] } | null>(null);

  // Where the dragged notation starts (its place in the panel) and lands (end of the answer).
  useLayoutEffect(() => {
    if (step !== 5) return;
    const box = boxRef.current?.getBoundingClientRect();
    const chip = chipRef.current?.getBoundingClientRect();
    const drop = dropRef.current?.getBoundingClientRect();
    if (!box || !chip || !drop) return;
    setPath({
      from: [chip.left - box.left, chip.top - box.top],
      to: [drop.left - box.left + 6, drop.top - box.top + drop.height / 2 - chip.height / 2],
    });
  }, [step]);

  const given = step >= 4;
  const dragging = step === 5 || step === 6;
  const dropped = step === 7;
  const at = step === 6 ? path?.to : path?.from;

  return (
    <div ref={boxRef} className="relative flex w-full max-w-[572px] items-start gap-3" aria-hidden>
      <div className="min-w-0 flex-1 rounded-xl border border-line bg-surface px-3.5 py-2.5 shadow-card">
        <Turn sp={1} name={text.interviewer}>
          {text.question}
        </Turn>
        <Turn sp={2} name={text.respondent} pointed>
          {text.before}{" "}
          {given ? (
            <span className="anim-fade text-tag italic">
              [{text.interviewer}: {text.interjection}]
            </span>
          ) : (
            <span className="relative">
              <span className={cx("rounded-[2px] transition-colors duration-200", step >= 1 && "bg-accent/20")}>{text.interjection}</span>
              {step >= 2 && (
                <span className="anim-pop absolute top-full left-full z-10 mt-1 -ml-3 flex flex-col items-start gap-1">
                  <span className="relative flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] leading-normal font-medium whitespace-nowrap text-fg-2 shadow-pop">
                    <Users className="size-3" />
                    {text.saidBy}
                    {step === 2 && <Pointer className="top-[55%] left-[60%]" />}
                  </span>
                  {step === 3 && (
                    <span className="anim-pop relative min-w-32 rounded-lg border border-line bg-surface p-1 shadow-pop">
                      <span className="flex h-6 items-center gap-1.5 rounded-md bg-surface-3 px-2 text-[12px] leading-normal not-italic">
                        <span className="size-2 rounded-full" style={{ background: "var(--sp1)" }} />
                        {text.interviewer}
                      </span>
                      <Pointer className="top-[45%] left-[55%]" />
                    </span>
                  )}
                </span>
              )}
              {step === 1 && <Pointer className="top-[60%] left-[90%]" />}
            </span>
          )}{" "}
          {text.after}
          <span ref={dropRef} className={cx("ml-0.5 inline-block h-[1.15em] w-0.5 translate-y-[3px] rounded-full", step === 6 ? "bg-accent" : "bg-transparent")} />
          {dropped && <span className="anim-pop inline-block text-tag italic">{text.tags[0]}</span>}
        </Turn>
      </div>
      <div className="flex w-[112px] shrink-0 flex-col gap-1.5 rounded-xl border border-line bg-surface px-2.5 pt-2 pb-2.5 shadow-card">
        <span className="text-[11px] font-semibold text-muted">{text.tagsPanel}</span>
        {text.tags.map((tag, i) => (
          <span
            key={tag}
            ref={i === 0 ? chipRef : undefined}
            className={cx(
              "flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[12px] italic",
              i === 0 && dragging ? "border-dashed border-line-strong text-muted" : "border-line bg-surface-2 text-tag",
            )}
          >
            <GripVertical className="size-3 shrink-0 text-muted" />
            {tag}
          </span>
        ))}
      </div>
      {dragging && at && (
        <span
          className="absolute top-0 left-0 z-20 flex items-center gap-1 rounded-md border border-line bg-surface px-1.5 py-0.5 text-[12px] whitespace-nowrap text-tag italic shadow-pop"
          style={{
            transform: `translate(${at[0]}px, ${at[1]}px) rotate(-3deg)`,
            transition: step === 6 ? "transform 750ms cubic-bezier(0.45, 0, 0.25, 1)" : undefined,
          }}
        >
          <GripVertical className="size-3 shrink-0 text-muted" />
          {text.tags[0]}
          <Pointer className="top-[55%] left-[60%]" />
        </span>
      )}
    </div>
  );
}

function FinishArt({ text }: { text: TutorialText["finish"] }) {
  const icons = [<Quote key="q" />, <ShieldCheck key="s" />, <Download key="d" />, <FileArchive key="z" />];
  return (
    <div className="grid w-full max-w-[576px] grid-cols-2 gap-2.5" aria-hidden>
      {text.tiles.map((tile, i) => (
        <div key={tile.title} className="flex items-center gap-3 rounded-xl border border-line bg-surface px-3.5 py-3 shadow-card">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent [&>svg]:size-[18px]">{icons[i]}</span>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">{tile.title}</div>
            <div className="mt-0.5 text-[12px] leading-snug text-fg-2">
              {i === 1 ? (
                <>
                  <span className="text-muted line-through">{text.pseudoFrom}</span>
                  {" → "}
                  <span className="font-medium text-accent">{text.pseudoTo}</span>
                </>
              ) : (
                withKeys(tile.cue)
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
