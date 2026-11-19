// The transcript editor: text linked to audio, correction tools, annotations and export.

import Document from "@tiptap/extension-document";
import Text from "@tiptap/extension-text";
import { UndoRedo } from "@tiptap/extensions";
import { TextSelection } from "@tiptap/pm/state";
import { EditorContent, useEditor, type Editor as TipTapEditor } from "@tiptap/react";
import {
  AudioLines,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  Info,
  MoreHorizontal,
  MousePointerClick,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  Share2,
  RotateCw,
  ShieldCheck,
  Sparkles,
  Tags,
  Users,
  ClipboardList,
  ListChecks,
  Quote as QuoteIcon,
  Search,
  X,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Settings as SettingsIcon,
  Redo2,
  Undo2,
  Loader2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Frame, OfflineBadge } from "@/components/Frame";
import { Button, cx, IconButton, Menu, MenuItem, Segmented, Select, Spinner, Tooltip } from "@/components/ui";
import "@/editor/editor.css";
import { InterviewDetails } from "@/components/InterviewDetails";
import { ExportDialog, type ExportTab } from "@/editor/ExportDialog";
import { AnonymizePanel, InfoPanel, MOD, QuotesPanel, SparseLinks, SpeakersPanel, TagsPanel, type Report } from "@/editor/panels";
import { useTagDrag } from "@/editor/tagDrag";
import { DetailCheck, type CheckSession } from "@/editor/DetailCheck";
import { Player, type Listen, type PlayerState } from "@/editor/player";
import {
  doubts as findDoubts,
  highlightKey,
  Highlights,
  pseudonymKey,
  pseudonymMatches,
  Pseudonyms,
  rangeAt,
  selectedPhrase,
  sentenceCount,
  selectionSpan,
  SYSTEM,
  timedRanges,
  timingAt,
  turnEnd,
  wholeWords,
  type HighlightMeta,
  type TimedRange,
} from "@/editor/plugins";
import { createTurn, fromDoc, Timing, toDoc, turnViews, type TimingAttrs } from "@/editor/schema";
import { anonymizeText, mergeRules, pseudonymSpans, wholeWord } from "@/lib/anonymize";
import type { QuoteExportItem } from "@/components/QuoteExport";
import { participantCodes, recordingOffset } from "@/lib/interviews";
import { isModifierOnly, keyCombo } from "@/lib/keys";
import { api, errorMessage, projectFileUrl, sourceFolderOf } from "@/lib/api";
import { exportShare } from "@/lib/share";
import { DEFAULT_TAGS, useT } from "@/lib/i18n";
import { useApp } from "@/lib/store";
import { formatClock } from "@/lib/transcript";
import type { AnonymizeRule, Project, ProjectExtras, Speaker, Transcript } from "@/lib/types";

interface Loaded {
  project: Project;
  transcript: Transcript;
  extras: ProjectExtras;
  report: Report | null;
  /** Transcript time to open at (from search or the quote list). */
  at?: number;
}

export function Editor({ projectId, at }: { projectId: string; at?: number }) {
  const go = useApp((s) => s.go);
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.getProject(projectId), api.loadTranscript(projectId), api.loadExtras(projectId), api.loadReport(projectId)])
      .then(([project, transcript, extras, report]) => {
        if (alive)
          setData({
            project,
            transcript,
            extras: { ...extras, anonymize: extras.anonymize ?? [], customTags: extras.customTags ?? [], quotes: extras.quotes ?? [] },
            report: report as Report | null,
            at,
          });
      })
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [projectId, at]);

  if (error) {
    return (
      <Frame title="" onBack={() => go({ name: "home" })}>
        <div className="selectable mx-auto mt-24 max-w-md text-center text-sm text-danger">{error}</div>
      </Frame>
    );
  }
  if (!data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  }
  return <EditorScreen {...data} />;
}

type PanelId = "speakers" | "tags" | "anonymize" | "quotes" | "details" | "info";


function EditorScreen({ project, transcript, extras: initialExtras, report, at }: Loaded) {
  const t = useT();
  const go = useApp((s) => s.go);
  const toast = useApp((s) => s.toast);
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);

  const [speakers, setSpeakers] = useState<Speaker[]>(transcript.speakers);
  const speakersRef = useRef(speakers);
  speakersRef.current = speakers;
  const [extras, setExtras] = useState<ProjectExtras>(initialExtras);
  // Interview details edited in the side panel (the player keeps using the loaded project).
  const [details, setDetails] = useState<Project>(project);
  const [panel, setPanel] = useState<PanelId>("speakers");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [clickPlays, setClickPlays] = useState(true);
  const clickPlaysRef = useRef(true);
  clickPlaysRef.current = clickPlays;
  const [speakerMenu, setSpeakerMenu] = useState<{ pos: number; x: number; y: number } | null>(null);
  const [stats, setStats] = useState({ words: 0, doubts: 0 });
  const [anonCounts, setAnonCounts] = useState<{ study: number[]; interview: number[] }>({ study: [], interview: [] });
  const [reviewedUntil, setReviewedUntil] = useState<number | null>(initialExtras.reviewedUntil ?? null);
  const [search, setSearch] = useState<{ open: boolean; focus: number }>({ open: false, focus: 0 });
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // ---------------------------------------------------------------- player
  const stereo = project.layout !== "single";
  const player = useMemo(() => new Player(projectFileUrl(project, "playback.m4a", project.updatedAt), stereo), [project, stereo]);
  const [ps, setPs] = useState<PlayerState>(player.snapshot);
  useEffect(() => {
    player.attach();
    const off = player.subscribe(setPs);
    return () => {
      off();
      player.destroy();
    };
  }, [player]);
  useEffect(() => player.setRewind(settings.rewindSeconds), [player, settings.rewindSeconds]);

  // ---------------------------------------------------------------- editor
  const editorRef = useRef<TipTapEditor | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const extensions = useMemo(
    () => [
      Document.extend({ content: "turn+" }),
      Text,
      Timing,
      createTurn({
        speakerName: (id) => speakersRef.current.find((s) => s.id === id)?.name ?? id,
        speakerIndex: (id) => Math.max(0, speakersRef.current.findIndex((s) => s.id === id)),
        formatTime: (s) => formatClock(s),
        onTimeClick: (s) => player.seek(s, true),
        onSpeakerClick: (pos, anchor) => {
          const r = anchor.getBoundingClientRect();
          setSpeakerMenu({ pos, x: r.left, y: r.bottom + 4 });
        },
      }),
      UndoRedo.configure({ depth: 300 }),
      Highlights.configure({ showDoubts: settings.showDoubts, threshold: settings.doubtThreshold }),
      Pseudonyms,
    ],
    // Extensions are created once; later setting changes reach the plugin through metas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [player],
  );

  // Saving: shortly after the last change, and immediately when leaving.
  const saveTimer = useRef<number | undefined>(undefined);
  const dirty = useRef(false);
  const flush = useCallback(async () => {
    window.clearTimeout(saveTimer.current);
    const ed = editorRef.current;
    if (!ed || !dirty.current) return;
    dirty.current = false;
    try {
      await api.saveTranscript(project.id, fromDoc(ed.state.doc, transcript, speakersRef.current));
      if (!dirty.current) {
        setSaveState("saved");
        setSavedAt(new Date());
      }
    } catch (e) {
      dirty.current = true;
      setSaveState("error");
      toast(errorMessage(e), "error");
    }
  }, [project.id, transcript, toast]);
  const scheduleSave = useCallback(() => {
    dirty.current = true;
    setSaveState("saving");
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void flush(), 500);
  }, [flush]);

  const ranges = useRef<TimedRange[]>([]);
  const rangesStale = useRef(true);
  const statsTimer = useRef<number | undefined>(undefined);
  const thresholdRef = useRef(settings.doubtThreshold);
  thresholdRef.current = settings.doubtThreshold;
  const study = useApp((s) => s.studies.find((x) => x.id === details.studyId));
  const studyRules = useMemo(() => study?.pseudonyms ?? [], [study]);
  const rulesRef = useRef(extras.anonymize);
  rulesRef.current = extras.anonymize;
  const studyRulesRef = useRef(studyRules);
  studyRulesRef.current = studyRules;

  const refreshStats = useCallback(() => {
    window.clearTimeout(statsTimer.current);
    statsTimer.current = window.setTimeout(() => {
      const ed = editorRef.current;
      if (!ed) return;
      const doc = ed.state.doc;
      let words = 0;
      const texts: string[] = [];
      doc.forEach((turn) => {
        const text = turn.textContent;
        texts.push(text);
        words += text.split(/\s+/).filter(Boolean).length;
      });
      setStats({ words, doubts: findDoubts(doc, thresholdRef.current).length });
      const count = (rule: { find: string }) => {
        const re = wholeWord(rule.find);
        return re ? texts.reduce((n, text) => n + (text.match(re)?.length ?? 0), 0) : 0;
      };
      setAnonCounts({ study: studyRulesRef.current.map(count), interview: rulesRef.current.map(count) });
    }, 250);
  }, []);

  const editor = useEditor({
    extensions,
    content: toDoc(transcript),
    editorProps: {
      attributes: { spellcheck: "false", autocorrect: "off", autocapitalize: "off" },
      // With text selected, typing must not replace it by accident: a selection is usually made
      // to listen to it or to mark it. Space plays or pauses; other typing keys do nothing.
      // Only Backspace/Delete (and cut or paste) change selected text.
      handleKeyDown(view, event) {
        if (view.state.selection.empty || event.isComposing) return false;
        if (event.metaKey || event.ctrlKey) return false;
        if (event.key === " " && !event.altKey && !event.shiftKey) {
          event.preventDefault();
          player.toggle();
          return true;
        }
        if (event.key.length === 1 || event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          return true;
        }
        return false;
      },
      handleTextInput(view) {
        // Dead keys, the character viewer and dictation arrive here instead of as key presses.
        return !view.state.selection.empty;
      },
      handleClick(view, pos, event) {
        if (!clickPlaysRef.current || event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
        const timing = timingAt(view.state, pos);
        if (timing && timing.k !== "n") player.seek(timing.s, true);
        return false;
      },
    },
    onUpdate: () => {
      rangesStale.current = true;
      scheduleSave();
      refreshStats();
    },
  });
  editorRef.current = editor;

  useEffect(() => {
    try {
      const dom = editor?.view.dom;
      dom?.setAttribute("spellcheck", settings.spellcheck ? "true" : "false");
      dom?.setAttribute("lang", transcript.language === "nl" ? "nl-NL" : "en-GB");
    } catch {
      // The view is not mounted yet; the effect runs again when it is.
    }
  }, [editor, settings.spellcheck, transcript.language]);

  useEffect(() => {
    refreshStats();
  }, [refreshStats, extras.anonymize, studyRules, settings.doubtThreshold]);

  // Leaving the screen or closing the window must not lose the last keystrokes.
  useEffect(() => {
    const onHide = () => void flush();
    window.addEventListener("blur", onHide);
    window.addEventListener("beforeunload", onHide);
    return () => {
      window.removeEventListener("blur", onHide);
      window.removeEventListener("beforeunload", onHide);
      void flush();
    };
  }, [flush]);

  const setHighlights = useCallback((meta: HighlightMeta) => {
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return;
    ed.view.dispatch(ed.state.tr.setMeta(highlightKey, meta).setMeta("addToHistory", false));
  }, []);

  useEffect(() => {
    setHighlights({ showDoubts: settings.showDoubts, threshold: settings.doubtThreshold });
  }, [setHighlights, settings.showDoubts, settings.doubtThreshold, editor]);

  // Pseudonymisation: show each pseudonym in place of the original in the text (the original
  // stays in the transcript; see the Pseudonyms plugin). Can be switched off in the panel.
  const previewRules = useMemo(() => mergeRules(extras.anonymize, studyRules), [extras.anonymize, studyRules]);
  const [showPseudonyms, setShowPseudonyms] = useState(() => {
    try {
      return localStorage.getItem("pt.showPseudonyms") !== "0";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("pt.showPseudonyms", showPseudonyms ? "1" : "0");
    } catch {
      // Remembering the choice is a convenience only.
    }
  }, [showPseudonyms]);
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return;
    const label = (text: string) => t("editor.anonOriginal", { text });
    ed.view.dispatch(ed.state.tr.setMeta(pseudonymKey, { on: showPseudonyms, rules: previewRules, label }).setMeta("addToHistory", false));
  }, [showPseudonyms, previewRules, editor, t]);

  // Follow the audio: highlight the spoken word and keep it in view.
  const lastManualScroll = useRef(0);
  useEffect(() => {
    let current = -1;
    player.onTick = (time) => {
      const ed = editorRef.current;
      if (!ed || ed.isDestroyed) return;
      if (rangesStale.current) {
        ranges.current = timedRanges(ed.state.doc);
        rangesStale.current = false;
        current = -1;
      }
      const idx = rangeAt(ranges.current, time, Math.max(0, current));
      if (idx === current) return;
      current = idx;
      const r = idx >= 0 ? ranges.current[idx] : null;
      setHighlights({ active: r ? { from: r.from, to: r.to } : null });
      const box = scrollRef.current;
      if (r && box && !player.audio.paused && performance.now() - lastManualScroll.current > 4000) {
        const rect = ed.view.coordsAtPos(r.from);
        const view = box.getBoundingClientRect();
        if (rect.top < view.top + 60 || rect.bottom > view.bottom - 120) {
          box.scrollBy({ top: rect.top - (view.top + view.height * 0.35), behavior: "smooth" });
        }
      }
    };
    return () => {
      player.onTick = null;
    };
  }, [player, setHighlights]);

  // ---------------------------------------------------------------- commands
  const toggleLoop = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const span = selectionSpan(ed.state);
    if (span && !(player.snapshot.loop && Math.abs(player.snapshot.loop.s - span.s) < 0.01)) {
      player.setLoop({ s: Math.max(0, span.s - 0.15), e: span.e + 0.2 });
      setHighlights({ loop: { from: span.from, to: span.to } });
    } else if (player.snapshot.loop) {
      player.setLoop(null);
      setHighlights({ loop: null });
    } else {
      toast(t("editor.loopHint"));
    }
  }, [player, setHighlights, toast, t]);

  /**
   * Go to the next or previous occurrence of a pseudonymisation term (as the export matches it).
   * The occurrence stays shown as its pseudonym, highlighted, and is scrolled to the middle.
   */
  const jumpToTerm = useCallback((find: string, direction: 1 | -1 | 0) => {
    const ed = editorRef.current;
    const box = scrollRef.current;
    if (!ed || !box) return;
    const list = pseudonymMatches(ed.state.doc, [{ find, replace: "" }]);
    if (list.length === 0) return;
    // Start from the previous jump; without one, from the cursor when it is on screen, else from
    // what is on screen now (the cursor may be far away, or nowhere yet). 0: the first one.
    const current = pseudonymKey.getState(ed.state)?.current ?? null;
    const r = box.getBoundingClientRect();
    let next: (typeof list)[number] | undefined;
    if (direction === 0) {
      next = list[0];
    } else if (current && list.some((m) => m.from === current.from)) {
      next = direction === 1 ? list.find((m) => m.from > current.from) : [...list].reverse().find((m) => m.from < current.from);
    } else {
      const head = ed.state.selection.head;
      const hc = ed.view.coordsAtPos(head);
      if (hc.top >= r.top && hc.bottom <= r.bottom) {
        next = direction === 1 ? list.find((m) => m.from > head) : [...list].reverse().find((m) => m.to < head);
      } else {
        const x = r.left + r.width / 2;
        const top = ed.view.posAtCoords({ left: x, top: r.top + 8 })?.pos ?? 0;
        const bottom = ed.view.posAtCoords({ left: x, top: r.bottom - 8 })?.pos ?? ed.state.doc.content.size;
        next = direction === 1 ? list.find((m) => m.from >= top) : [...list].reverse().find((m) => m.to <= bottom);
      }
    }
    next ??= direction === 1 ? list[0] : list[list.length - 1];
    // Only the highlight moves; the editor's selection is left alone. Selecting the folded-away
    // original made WebKit move the selection itself, which revealed the original and lost the jump.
    ed.view.dispatch(ed.state.tr.setMeta(pseudonymKey, { current: { from: next.from, to: next.to } }).setMeta("addToHistory", false));
    lastManualScroll.current = performance.now();
    // Centre the highlighted pseudonym (or the original, with pseudonyms off) in the transcript.
    const el = box.querySelector<HTMLElement>(".anon-chip.current, .search-hit.current");
    const c = el ? el.getBoundingClientRect() : ed.view.coordsAtPos(next.from);
    const target = box.scrollTop + (c.top - r.top) - (r.height - (c.bottom - c.top)) / 2;
    box.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }, []);

  const jumpDoubt = useCallback(
    (direction: 1 | -1) => {
      const ed = editorRef.current;
      if (!ed) return;
      const list = findDoubts(ed.state.doc, thresholdRef.current);
      if (list.length === 0) {
        toast(t("editor.noDoubts"), "ok");
        return;
      }
      const { from, to } = ed.state.selection;
      const next = direction === 1 ? (list.find((d) => d.from >= to && !(d.from === from && d.to === to)) ?? list[0]) : ([...list].reverse().find((d) => d.to <= from) ?? list[list.length - 1]);
      ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, next.from, next.to)).scrollIntoView());
      ed.view.focus();
      lastManualScroll.current = performance.now();
      const timing = timingAt(ed.state, next.from);
      if (timing) {
        // Hear the word in context without running on.
        player.setLoop(null);
        setHighlights({ loop: null });
        player.seek(Math.max(0, timing.s - 1.2), true);
      }
    },
    [player, setHighlights, toast, t],
  );

  const confirmWord = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const { from, to } = ed.state.selection;
    const type = ed.state.schema.marks.timing;
    let tr = ed.state.tr;
    let changed = false;
    ed.state.doc.nodesBetween(Math.max(0, from - 1), Math.min(ed.state.doc.content.size, to + 1), (node, pos) => {
      const mark = node.marks.find((m) => m.type === type);
      if (node.isText && mark && mark.attrs.k === "w" && mark.attrs.c < 1) {
        tr = tr.addMark(pos, pos + node.nodeSize, type.create({ ...(mark.attrs as TimingAttrs), c: 1 }));
        changed = true;
      }
    });
    if (changed) ed.view.dispatch(tr.setMeta(SYSTEM, true));
    jumpDoubt(1);
  }, [jumpDoubt]);

  const insertTag = useCallback(
    (tag: string) => {
      const ed = editorRef.current;
      if (!ed) return;
      const { state } = ed;
      // "[onverstaanbaar]" replaces what is selected (the part nobody can make out) and gets
      // the time in the original recording, so it can be looked up later.
      const inaudible = /^\[(onverstaanbaar|inaudible)\]$/i.test(tag);
      // Any other tag never replaces what is selected (the "next doubt" key selects a whole
      // word): it goes right after it.
      const to = state.selection.to;
      const from = inaudible ? state.selection.from : to;
      const before = from > 0 ? state.doc.textBetween(from - 1, from, "\n") : "\n";
      const after = to < state.doc.content.size ? state.doc.textBetween(to, to + 1, "\n") : "\n";
      const near = timingAt(state, inaudible && from < to ? from + 1 : from);
      const at = near ? (near.k === "n" || inaudible ? near.s : near.e) : player.snapshot.time;
      const mark = state.schema.marks.timing.create({ s: at, e: at, c: 1, k: "n", sp: null });
      const text = inaudible ? `${tag.slice(0, -1)} ${formatClock(at + recordingOffset(detailsRef.current))}]` : tag;
      const parts = [];
      if (before.trim() !== "") parts.push(state.schema.text(" "));
      parts.push(state.schema.text(text, [mark]));
      // A space only before a following word, not before punctuation ("[lacht].").
      if (/^[\p{L}\p{N}[(]/u.test(after)) parts.push(state.schema.text(" "));
      let tr = state.tr.replaceWith(from, to, parts);
      // Continue typing as plain text, not inside the tag.
      tr = tr.setStoredMarks([]).setMeta(SYSTEM, true).scrollIntoView();
      ed.view.dispatch(tr);
      ed.view.focus();
    },
    [player],
  );

  const detailsRef = useRef(details);
  detailsRef.current = details;

  // An annotation dragged from the tool row or the side panel goes where it is dropped.
  const tagDrag = useTagDrag(
    useCallback(() => editorRef.current?.view ?? null, []),
    useCallback(
      (tag: string, pos: number) => {
        const ed = editorRef.current;
        if (!ed) return;
        ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, pos)));
        insertTag(tag);
      },
      [insertTag],
    ),
  );

  // A lecture or presentation (one speaker, or a clean non-verbatim transcript) starts without
  // the built-in labels ([lacht], [stilte], ...); "Restore" in the panel brings them back.
  const lecture = project.speakerCount === 1 || project.verbatim === false;
  const hiddenTags = useMemo(
    () => extras.hiddenTags ?? (lecture ? DEFAULT_TAGS[transcript.language] : []),
    [extras.hiddenTags, lecture, transcript.language],
  );
  const defaultTags = useMemo(() => DEFAULT_TAGS[transcript.language].filter((tag) => !hiddenTags.includes(tag)), [transcript.language, hiddenTags]);
  const tags = useMemo(() => [...defaultTags, ...extras.customTags], [defaultTags, extras.customTags]);
  const tagsRef = useRef(tags);
  tagsRef.current = tags;

  const saveExtras = useCallback(
    (next: ProjectExtras) => {
      setExtras(next);
      api.saveExtras(project.id, next).catch((e) => toast(errorMessage(e), "error"));
    },
    [project.id, toast],
  );

  const renameSpeaker = useCallback(
    (id: string, name: string) => {
      const next = speakersRef.current.map((s) => (s.id === id ? { ...s, name } : s));
      speakersRef.current = next;
      setSpeakers(next);
      const ed = editorRef.current;
      if (ed) {
        // Inline backchannels carry the name in their text.
        const type = ed.state.schema.marks.timing;
        const edits: { from: number; to: number; text: string; attrs: TimingAttrs }[] = [];
        ed.state.doc.descendants((node, pos) => {
          const mark = node.marks.find((m) => m.type === type);
          if (node.isText && node.text && mark && mark.attrs.k === "b" && mark.attrs.sp === id) {
            const said = /^\[[^:\]]*: ([^\]]*)\]/.exec(node.text)?.[1];
            if (said !== undefined) edits.push({ from: pos, to: pos + node.nodeSize, text: `[${name}: ${said}]`, attrs: mark.attrs as TimingAttrs });
          }
        });
        if (edits.length > 0) {
          let tr = ed.state.tr;
          for (const e of edits.reverse()) tr = tr.replaceWith(e.from, e.to, ed.state.schema.text(e.text, [type.create(e.attrs)]));
          ed.view.dispatch(tr.setMeta(SYSTEM, true));
        }
      }
      turnViews.forEach((v) => v.refresh());
      scheduleSave();
    },
    [scheduleSave],
  );

  const addSpeaker = useCallback(() => {
    const n = speakersRef.current.length + 1;
    let id = `S${n}`;
    while (speakersRef.current.some((s) => s.id === id)) id += "x";
    const next = [...speakersRef.current, { id, name: `${t("common.speaker")} ${n}` }];
    speakersRef.current = next;
    setSpeakers(next);
    scheduleSave();
    return id;
  }, [scheduleSave, t]);

  const setTurnSpeaker = useCallback((pos: number, id: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    const node = ed.state.doc.nodeAt(pos);
    if (node?.type.name === "turn") ed.view.dispatch(ed.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, speaker: id }));
    setSpeakerMenu(null);
  }, []);

  // ---------------------------------------------------------------- words said by someone else
  // A short reply inside another speaker's paragraph ("ja, klopt") can be given to the right
  // speaker without starting a new paragraph: it becomes an inline "[Name: ja, klopt]", the same
  // as the backchannels the recogniser places itself. Selecting the whole paragraph changes the
  // paragraph's speaker instead.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [saidByAt, setSaidByAt] = useState<{ x: number; y: number } | null>(null);
  const [saidByMenu, setSaidByMenu] = useState<{ x: number; y: number; exclude: string } | null>(null);
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const { state, view } = editor;
      const { from, to, empty } = state.selection;
      const box = contentRef.current;
      if (empty || !box || !view.hasFocus() || state.doc.resolve(from).parent !== state.doc.resolve(to).parent || !selectionSpan(state)) {
        setSaidByAt(null);
        return;
      }
      const end = view.coordsAtPos(to);
      const r = box.getBoundingClientRect();
      setSaidByAt({ x: Math.min(end.left - r.left, r.width - 150), y: end.bottom - r.top + 6 });
    };
    const hide = () => setSaidByAt(null);
    editor.on("selectionUpdate", update);
    editor.on("focus", update);
    editor.on("blur", hide);
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("focus", update);
      editor.off("blur", hide);
    };
  }, [editor]);

  const assignWords = useCallback(
    (id: string) => {
      setSaidByMenu(null);
      const ed = editorRef.current;
      if (!ed) return;
      const { state } = ed;
      if (state.selection.empty) return;
      let { from, to } = wholeWords(state.doc, state.selection.from, state.selection.to);
      const $from = state.doc.resolve(from);
      if ($from.parent !== state.doc.resolve(to).parent || $from.depth < 1) return;
      const turn = $from.node(1);
      const turnPos = $from.before(1);
      while (from < to && /\s/.test(state.doc.textBetween(from, from + 1))) from++;
      while (to > from && /\s/.test(state.doc.textBetween(to - 1, to))) to--;
      const picked = state.doc.textBetween(from, to, " ");
      if (!picked) return;
      if (picked === turn.textContent.trim()) {
        setTurnSpeaker(turnPos, id);
        return;
      }
      // More than one sentence is a turn of its own, not a reply in passing: the paragraph is
      // split around the selection, which goes to the chosen speaker; what comes before and
      // after it stays with the paragraph's own speaker.
      if (sentenceCount(picked) > 1) {
        const start = $from.start();
        const end = $from.end();
        const space = (a: number) => /\s/.test(state.doc.textBetween(a, a + 1));
        let tr = state.tr;
        let after = to;
        while (after < end && space(after)) after++;
        if (after < end) tr = tr.delete(to, after).split(to, 1, [{ type: turn.type, attrs: { ...turn.attrs } }]);
        let before = from;
        while (before > start && space(before - 1)) before--;
        if (before > start) tr = tr.delete(before, from).split(before, 1, [{ type: turn.type, attrs: { ...turn.attrs, speaker: id } }]);
        else tr = tr.setNodeMarkup(turnPos, undefined, { ...turn.attrs, speaker: id });
        ed.view.dispatch(tr.scrollIntoView());
        ed.view.focus();
        return;
      }
      // An inline reply that was given to the wrong person keeps its words; other bracketed
      // notes (fillers, tags) are left out of the reply.
      const said = (/^\[[^:\]]+: ([^\]]*)\]$/.exec(picked)?.[1] ?? picked.replace(/\[[^\]]*\]/g, " ")).replace(/\s+/g, " ").trim();
      if (!said) return;
      // The reply's audio: from its first to its last recognised word; typed text takes the
      // position of the word before it.
      let s = Infinity;
      let e = -Infinity;
      let before = 0;
      state.doc.nodesBetween(0, to, (node, pos) => {
        if (!node.isText) return;
        const mark = node.marks.find((m) => m.type.name === "timing");
        if (!mark) return;
        const a = mark.attrs as TimingAttrs;
        if (pos + node.nodeSize <= from) {
          if (a.k !== "n") before = Math.max(before, a.e);
        } else if (a.k === "w" || a.k === "f" || a.k === "b") {
          s = Math.min(s, a.s);
          e = Math.max(e, a.e);
        }
      });
      if (!Number.isFinite(s)) s = e = before;
      const name = speakersRef.current.find((x) => x.id === id)?.name ?? id;
      const type = state.schema.marks.timing;
      const mark = type.create({ s, e, c: 1, k: "b", sp: id } satisfies TimingAttrs);
      ed.view.dispatch(state.tr.replaceWith(from, to, state.schema.text(`[${name}: ${said}]`, [mark])));
      ed.view.focus();
    },
    [setTurnSpeaker],
  );


  // ---------------------------------------------------------------- quotes
  const addQuote = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    let { state } = ed;
    // Whole words only: a quote that starts or ends halfway through a word is a slip.
    if (!state.selection.empty) {
      const r = wholeWords(state.doc, state.selection.from, state.selection.to);
      ed.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, r.from, r.to)));
      state = ed.state;
    }
    const { from, to } = state.selection;
    const text = state.doc.textBetween(from, to, " ").trim();
    const span = selectionSpan(state);
    if (!text || !span) {
      toast(t("quotes.selectFirst"), "info");
      return;
    }
    const speaker = (state.doc.resolve(from).node(1)?.attrs.speaker as string | undefined) ?? "";
    const quote = { id: crypto.randomUUID(), text, s: span.s, e: span.e, speaker, note: "", createdAt: Date.now() };
    setExtras((current) => {
      const next = { ...current, quotes: [...(current.quotes ?? []), quote].sort((a, b) => a.s - b.s) };
      api.saveExtras(project.id, next).catch((e) => toast(errorMessage(e), "error"));
      return next;
    });
    toast(t("quotes.saved"), "ok");
  }, [project.id, toast, t]);

  // Opened from search or the quote list: go to that moment.
  useEffect(() => {
    if (at === undefined || !editor) return;
    const timer = window.setTimeout(() => {
      const ed = editorRef.current;
      if (!ed) return;
      player.seek(at);
      const list = timedRanges(ed.state.doc);
      const i = rangeAt(list, at, 0);
      const r = list[i];
      if (r) {
        ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, r.from, r.to)).scrollIntoView());
        ed.view.focus();
      }
    }, 150);
    return () => window.clearTimeout(timer);
  }, [at, editor, player]);

  // ---------------------------------------------------------------- passages to listen to
  // Recognition found far fewer words than there was speech somewhere (see the pipeline's
  // sparse check). Said once, calmly, until the person has seen it; the Info panel keeps the list.
  const jumpTo = useCallback(
    (seconds: number) => {
      const ed = editorRef.current;
      if (!ed) return;
      player.seek(seconds);
      const list = timedRanges(ed.state.doc);
      const r = list[rangeAt(list, seconds, 0)];
      if (r) {
        ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, r.from, r.to)).scrollIntoView());
        ed.view.focus();
      }
    },
    [player],
  );
  const sparse = report?.sparse ?? [];
  const sparseKey = `pt.sparseSeen.${project.id}`;
  const [sparseSeen, setSparseSeen] = useState(() => {
    try {
      return localStorage.getItem(sparseKey) === "1";
    } catch {
      return false;
    }
  });
  const dismissSparse = () => {
    setSparseSeen(true);
    try {
      localStorage.setItem(sparseKey, "1");
    } catch {
      // Remembering is a convenience only.
    }
  };

  // ---------------------------------------------------------------- checked up to here
  useEffect(() => {
    setHighlights({ reviewedUntil });
  }, [reviewedUntil, setHighlights, editor]);
  const lastEnd = useMemo(() => transcript.paragraphs[transcript.paragraphs.length - 1]?.end ?? transcript.duration, [transcript]);
  const reviewedPct = reviewedUntil ? Math.min(100, Math.round((reviewedUntil / Math.max(lastEnd, 1)) * 100)) : 0;

  const markReviewed = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const { doc, selection } = ed.state;
    // The turn with the text cursor; if the editor is not in use, the turn being played.
    let index = doc.resolve(selection.from).index(0);
    if (!ed.isFocused && player.snapshot.time > 0) {
      const time = player.snapshot.time;
      doc.forEach((turn, _offset, i) => {
        const end = turnEnd(turn);
        if (end !== null && end <= time + 0.5) index = i;
      });
    }
    const end = turnEnd(doc.child(Math.min(index, doc.childCount - 1)));
    if (end === null) return;
    setReviewedUntil(end);
    setExtras((current) => {
      const next = { ...current, reviewedUntil: end };
      api.saveExtras(project.id, next).catch((e) => toast(errorMessage(e), "error"));
      return next;
    });
    if (end >= lastEnd - 0.05 && detailsRef.current.review === "todo") {
      toast(t("editor.reviewedDone"), "ok", {
        label: t("editor.markChecked"),
        run: () => void api.updateProject(project.id, { review: "checked" }).then(setDetails, (e) => toast(errorMessage(e), "error")),
      });
    }
  }, [player, project.id, lastEnd, toast, t]);

  // Study rules are saved after a short pause, since they are typed character by character.
  const studySaveTimer = useRef<number | undefined>(undefined);
  const saveStudyRules = useCallback(
    (rules: AnonymizeRule[]) => {
      if (!study) return;
      useApp.getState().putStudy({ ...study, pseudonyms: rules });
      window.clearTimeout(studySaveTimer.current);
      studySaveTimer.current = window.setTimeout(() => {
        api.updateStudy(study.id, { pseudonyms: rules }).catch((e) => toast(errorMessage(e), "error"));
      }, 500);
    },
    [study, toast],
  );
  useEffect(() => () => window.clearTimeout(studySaveTimer.current), []);

  // ---------------------------------------------------------------- pseudonymisation check
  const [check, setCheck] = useState<CheckSession | null>(null);
  const keepTerms = useMemo(() => [...(extras.keepTerms ?? []), ...(study?.keepTerms ?? [])], [extras.keepTerms, study]);
  const addRule = useCallback(
    (rule: AnonymizeRule, studyWide: boolean) => {
      if (studyWide && study) saveStudyRules([...studyRules, rule]);
      else saveExtras({ ...extras, anonymize: [...extras.anonymize, rule] });
    },
    [study, studyRules, saveStudyRules, extras, saveExtras],
  );
  const keepTerm = useCallback(
    (term: string, studyWide: boolean) => {
      if (studyWide && study) {
        const list = [...study.keepTerms, term];
        useApp.getState().putStudy({ ...study, keepTerms: list });
        api.updateStudy(study.id, { keepTerms: list }).catch((e) => toast(errorMessage(e), "error"));
      } else {
        saveExtras({ ...extras, keepTerms: [...(extras.keepTerms ?? []), term] });
      }
    },
    [study, extras, saveExtras, toast],
  );
  /** Play from just before the occurrence the check (or the panel's arrows) highlighted. */
  const listenAtHighlight = useCallback(() => {
    const ed = editorRef.current;
    const cur = ed ? pseudonymKey.getState(ed.state)?.current : null;
    const timing = ed && cur ? timingAt(ed.state, cur.from) : null;
    if (timing) player.seek(Math.max(0, timing.s - 1.5), true);
  }, [player]);

  // ---------------------------------------------------------------- quote export
  const [exportTab, setExportTab] = useState<ExportTab>("transcript");
  const buildQuoteExport = useCallback(
    (pseudo: boolean): QuoteExportItem[] => {
      const rules = pseudo ? previewRules : [];
      const nameOf = (id: string) => speakersRef.current.find((s) => s.id === id)?.name ?? id;
      const ed = editorRef.current;
      const current = ed ? fromDoc(ed.state.doc, transcript, speakersRef.current) : transcript;
      return [...(extras.quotes ?? [])]
        .sort((a, b) => a.s - b.s)
        .map((q) => ({
          projectId: project.id,
          s: q.s,
          e: q.e,
          spans: pseudonymSpans(current, previewRules, q.s - 2, q.e + 2),
          line: {
            text: anonymizeText(q.text, rules),
            participant: participantCodes(details, study) || anonymizeText(nameOf(q.speaker), rules),
            interview: anonymizeText(details.name, rules),
            time: formatClock(q.s + recordingOffset(details)),
            note: anonymizeText(q.note, rules),
          },
        }));
    },
    [extras.quotes, previewRules, project.id, details, study, transcript],
  );
  const quoteSource = useMemo(
    () => ({
      name: details.name,
      count: extras.quotes?.length ?? 0,
      hasPseudonyms: previewRules.length > 0,
      build: buildQuoteExport,
      startFolder: () => sourceFolderOf(project),
    }),
    [details.name, extras.quotes, previewRules, buildQuoteExport, project],
  );

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inField = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
      const mod = e.ctrlKey || e.metaKey;
      const done = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      const overlay = () => document.querySelector("[role=dialog],[role=menu],[role=listbox],[data-popup]");
      // Keys chosen in Settings (for example a foot pedal) work everywhere except in dialogs.
      const combo = isModifierOnly(e) ? "" : keyCombo(e);
      const keys = settingsRef.current;
      if (combo && !overlay() && combo === keys.keyPlayPause) {
        done();
        player.toggle();
        return;
      }
      if (combo && !overlay() && combo === keys.keyBack) {
        done();
        player.skip(-3);
        return;
      }
      if (combo && !overlay() && combo === keys.keyForward) {
        done();
        player.skip(3);
        return;
      }
      if (mod && !e.shiftKey && (e.key.toLowerCase() === "f" || e.key.toLowerCase() === "h")) {
        done();
        setSearch((s) => ({ open: true, focus: s.focus + 1 }));
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "u" && !inField) {
        done();
        addQuote();
        return;
      }
      if (mod && e.shiftKey && e.key === "Enter" && !inField) {
        done();
        markReviewed();
        return;
      }
      if (e.key === "Escape" && !inField && !overlay()) {
        done();
        player.toggle();
      } else if (mod && e.code === "Space") {
        done();
        player.toggle();
      } else if (e.altKey && e.key === "ArrowLeft") {
        done();
        player.skip(-3);
      } else if (e.altKey && e.key === "ArrowRight") {
        done();
        player.skip(3);
      } else if (e.altKey && e.key === "ArrowDown") {
        done();
        player.setRate(player.snapshot.rate - 0.1);
      } else if (e.altKey && e.key === "ArrowUp") {
        done();
        player.setRate(player.snapshot.rate + 0.1);
      } else if (e.key === "F8") {
        done();
        jumpDoubt(e.shiftKey ? -1 : 1);
      } else if (mod && e.key === "Enter" && !inField) {
        done();
        confirmWord();
      } else if (mod && e.key.toLowerCase() === "l" && !inField) {
        done();
        toggleLoop();
      } else if (!inField && ((mod && /^[1-9]$/.test(e.key)) || /^F[1-6]$/.test(e.key))) {
        const index = Number(e.key.replace("F", "")) - 1;
        const tag = tagsRef.current[index];
        if (tag) {
          done();
          insertTag(tag);
        }
      } else if (mod && e.key.toLowerCase() === "s") {
        done();
        void flush();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [player, jumpDoubt, confirmWord, toggleLoop, insertTag, flush, markReviewed, addQuote]);

  // ---------------------------------------------------------------- render
  const leave = async (route: Parameters<typeof go>[0]) => {
    await flush();
    go(route);
  };
  const getTranscript = useCallback(() => fromDoc(editorRef.current!.state.doc, transcript, speakersRef.current), [transcript]);

  const panels: { id: PanelId; label: string; icon: React.ReactNode }[] = [
    { id: "speakers", label: t("editor.speakers"), icon: <Users className="size-4" /> },
    { id: "tags", label: t("editor.tags"), icon: <Tags className="size-4" /> },
    { id: "anonymize", label: t("editor.anonymize"), icon: <ShieldCheck className="size-4" /> },
    { id: "quotes", label: t("quotes.title"), icon: <QuoteIcon className="size-4" /> },
    { id: "details", label: t("interview.title"), icon: <ClipboardList className="size-4" /> },
    { id: "info", label: t("editor.info"), icon: <Info className="size-4" /> },
  ];

  return (
    <Frame
      title={
        <EditableTitle
          value={details.name}
          onSave={(name) => void api.updateProject(project.id, { name }).then(setDetails, (e) => toast(errorMessage(e), "error"))}
        />
      }
      subtitle={<SaveStatus state={saveState} at={savedAt} />}
      onBack={() => void leave({ name: "home" })}
      bodyClassName="flex min-h-0 flex-1 flex-col"
      actions={
        <>
          <OfflineBadge />
          <IconButton label={t("help.title")} onClick={() => void leave({ name: "help" })}>
            <CircleHelp className="size-[18px]" />
          </IconButton>
          <IconButton label={t("common.settings")} onClick={() => void leave({ name: "settings" })}>
            <SettingsIcon className="size-[18px]" />
          </IconButton>
          <Menu
            trigger={
              <IconButton label={t("home.more")}>
                <MoreHorizontal className="size-[18px]" />
              </IconButton>
            }
          >
            <MenuItem icon={<RotateCcw />} disabled={!project.hasRecordings} onSelect={() => void leave({ name: "setup", id: project.id })}>
              {t(project.hasRecordings ? "editor.retranscribe" : "editor.retranscribeNoRecordings")}
            </MenuItem>
            <MenuItem icon={<Share2 />} onSelect={() => void flush().then(() => exportShare(t, { project }))}>
              {t("share.export")}
            </MenuItem>
          </Menu>
          <Button variant="primary" icon={<Download className="size-4" />} onClick={() => void flush().then(() => {
              setExportTab("transcript");
              setExportOpen(true);
            })}>
            {t("editor.export")}
          </Button>
        </>
      }
    >
      {/* Tool row */}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-surface px-3">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tags.slice(0, 9).map((tag, i) => (
            <Tooltip key={tag} label={t("editor.scTag")} shortcut={`${MOD}+${i + 1}`}>
              <button
                onMouseDown={(e) => e.preventDefault()}
                onPointerDown={(e) => tagDrag.start(tag, e)}
                onClick={() => !tagDrag.wasDrag() && insertTag(tag)}
                className="h-7 shrink-0 cursor-grab rounded-md bg-tag-soft px-2 text-xs font-medium text-tag italic hover:brightness-95"
              >
                {tag}
              </button>
            </Tooltip>
          ))}
        </div>
        <div className="mx-1 h-5 w-px shrink-0 bg-line" />
        <IconButton label={t("editor.clickPlays")} size="sm" active={clickPlays} onClick={() => setClickPlays((v) => !v)}>
          <MousePointerClick className="size-4" />
        </IconButton>
        <IconButton label={t("editor.showDoubts")} size="sm" active={settings.showDoubts} onClick={() => updateSettings({ showDoubts: !settings.showDoubts })}>
          {settings.showDoubts ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
        </IconButton>
        <div className="flex shrink-0 items-center rounded-lg bg-doubt-soft">
          <IconButton label={t("editor.prevDoubt")} shortcut="Shift+F8" size="sm" onClick={() => jumpDoubt(-1)} disabled={stats.doubts === 0}>
            <ChevronLeft className="size-4" />
          </IconButton>
          <Tooltip label={t("editor.nextDoubt")} shortcut="F8">
            <button
              onClick={() => jumpDoubt(1)}
              disabled={stats.doubts === 0}
              className="tabular h-7 px-1 text-xs font-medium text-fg disabled:opacity-60"
            >
              {stats.doubts > 0 ? t("editor.doubtsLeft", { n: stats.doubts }) : t("editor.noDoubts")}
            </button>
          </Tooltip>
          <IconButton label={t("editor.nextDoubt")} shortcut="F8" size="sm" onClick={() => jumpDoubt(1)} disabled={stats.doubts === 0}>
            <ChevronRight className="size-4" />
          </IconButton>
        </div>
        <IconButton label={t("editor.confirmWord")} shortcut={`${MOD}+Enter`} size="sm" onClick={confirmWord} disabled={stats.doubts === 0}>
          <Check className="size-4" />
        </IconButton>
        <div className="mx-1 h-5 w-px shrink-0 bg-line" />
        <Tooltip label={t("editor.reviewedHere")} shortcut={`${MOD}+Shift+Enter`}>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={markReviewed}
            className={cx(
              "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium",
              reviewedPct > 0 ? "bg-ok-soft text-ok" : "text-fg-2 hover:bg-surface-3",
            )}
          >
            <ListChecks className="size-4" />
            <span className="tabular">{t("editor.reviewedProgress", { pct: reviewedPct })}</span>
          </button>
        </Tooltip>
        <IconButton label={t("common.undo")} shortcut={`${MOD}+Z`} size="sm" onMouseDown={(e) => e.preventDefault()} onClick={() => editorRef.current?.commands.undo()}>
          <Undo2 className="size-4" />
        </IconButton>
        <IconButton label={t("common.redo")} shortcut={`${MOD}+Shift+Z`} size="sm" onMouseDown={(e) => e.preventDefault()} onClick={() => editorRef.current?.commands.redo()}>
          <Redo2 className="size-4" />
        </IconButton>
        <IconButton label={t("quotes.add")} shortcut={`${MOD}+U`} size="sm" onMouseDown={(e) => e.preventDefault()} onClick={addQuote}>
          <QuoteIcon className="size-4" />
        </IconButton>
        <IconButton label={t("editor.find")} shortcut={`${MOD}+F`} size="sm" active={search.open} onClick={() => setSearch((s) => ({ open: !s.open, focus: s.focus + 1 }))}>
          <Search className="size-4" />
        </IconButton>
      </div>
      {sparse.length > 0 && !sparseSeen && (
        <div className="flex shrink-0 items-start gap-3 border-b border-line bg-warn-soft px-4 py-2.5 text-[13px] leading-relaxed">
          <Info className="mt-0.5 size-4 shrink-0 text-warn" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span>{t("editor.sparseText")}</span>
            <SparseLinks spans={sparse} onJump={jumpTo} />
          </div>
          <Button variant="ghost" size="sm" onClick={dismissSparse}>
            {t("editor.sparseDismiss")}
          </Button>
        </div>
      )}
      {search.open && editor && <SearchBar editor={editor} focus={search.focus} onClose={() => setSearch((s) => ({ ...s, open: false }))} />}

      <div className="flex min-h-0 flex-1">
        {/* Transcript */}
        <div
          ref={scrollRef}
          className={cx("transcript min-w-0 flex-1 overflow-y-auto bg-surface", clickPlays && "click-plays")}
          onWheel={() => (lastManualScroll.current = performance.now())}
          onPointerDown={() => (lastManualScroll.current = performance.now())}
        >
          <div ref={contentRef} className="relative mx-auto max-w-[860px] px-8">
            <EditorContent editor={editor} />
            {saidByAt && (
              <Tooltip label={t("editor.saidByHint")}>
                <button
                  // Keeps the selection in the text: the button must not take the focus on press.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    const ed = editorRef.current;
                    const r = e.currentTarget.getBoundingClientRect();
                    const exclude = ed ? ((ed.state.doc.resolve(ed.state.selection.from).node(1)?.attrs.speaker as string | undefined) ?? "") : "";
                    setSaidByMenu({ x: r.left, y: r.bottom + 4, exclude });
                  }}
                  className="anim-pop absolute z-20 flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-xs font-medium text-fg-2 shadow-pop hover:bg-surface-3"
                  style={{ left: saidByAt.x, top: saidByAt.y }}
                >
                  <Users className="size-3.5" />
                  {t("editor.saidBy")}
                </button>
              </Tooltip>
            )}
          </div>
        </div>

        {/* Side panel */}
        <aside className="flex w-[300px] shrink-0 flex-col border-l border-line bg-bg">
          <div className="flex shrink-0 gap-1 border-b border-line p-2">
            {panels.map((p) => (
              <Tooltip key={p.id} label={p.label}>
                <button
                  onClick={() => setPanel(p.id)}
                  aria-label={p.label}
                  aria-pressed={panel === p.id}
                  className={cx(
                    "flex h-8 flex-1 items-center justify-center rounded-lg transition-colors",
                    panel === p.id ? "bg-surface text-accent shadow-card" : "text-fg-2 hover:bg-surface-3",
                  )}
                >
                  {p.icon}
                </button>
              </Tooltip>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {panel === "speakers" && <SpeakersPanel speakers={speakers} onRename={renameSpeaker} onAdd={addSpeaker} />}
            {panel === "tags" && (
              <TagsPanel
                defaults={defaultTags}
                custom={extras.customTags}
                onInsert={insertTag}
                drag={tagDrag}
                onAdd={(tag) => saveExtras({ ...extras, customTags: [...extras.customTags, tag] })}
                onRemove={(tag) =>
                  saveExtras(
                    extras.customTags.includes(tag)
                      ? { ...extras, customTags: extras.customTags.filter((x) => x !== tag) }
                      : { ...extras, hiddenTags: [...hiddenTags, tag] },
                  )
                }
                onRestoreDefaults={hiddenTags.length > 0 ? () => saveExtras({ ...extras, hiddenTags: [] }) : undefined}
              />
            )}
            {panel === "anonymize" && (
              <AnonymizePanel
                studyName={study?.name ?? null}
                studyRules={studyRules}
                interviewRules={extras.anonymize}
                studyCounts={anonCounts.study}
                interviewCounts={anonCounts.interview}
                onStudyRules={saveStudyRules}
                onInterviewRules={(rules: AnonymizeRule[]) => saveExtras({ ...extras, anonymize: rules })}
                showInText={showPseudonyms}
                onShowInText={setShowPseudonyms}
                onJump={jumpToTerm}
                selection={() => (editorRef.current ? selectedPhrase(editorRef.current.state) : "")}
                check={
                  <DetailCheck
                    session={check}
                    onSession={setCheck}
                    lang={transcript.language}
                    inStudy={!!study}
                    getTranscript={getTranscript}
                    glossary={[...(study?.glossary ?? []), ...(details.glossary ?? [])]}
                    rules={previewRules}
                    keep={keepTerms}
                    onReplace={addRule}
                    onKeep={keepTerm}
                    onShow={jumpToTerm}
                    onListen={listenAtHighlight}
                  />
                }
              />
            )}
            {panel === "quotes" && (
              <QuotesPanel
                quotes={extras.quotes ?? []}
                speakerName={(id) => speakers.find((s) => s.id === id)?.name ?? id}
                formatTime={(s) => formatClock(s + recordingOffset(details))}
                onPlay={(q) => player.seek(q.s, true)}
                onChange={(quotes) => saveExtras({ ...extras, quotes })}
                onAdd={addQuote}
                onExport={() => void flush().then(() => {
                  setExportTab("quotes");
                  setExportOpen(true);
                })}
              />
            )}
            {panel === "details" && <InterviewDetails project={details} onChange={setDetails} compact />}
            {panel === "info" && <InfoPanel words={stats.words} duration={transcript.duration} doubts={stats.doubts} report={report} onJump={jumpTo} />}
          </div>
        </aside>
      </div>

      <PlayerBar player={player} state={ps} stereo={stereo} speakers={speakers} onToggleLoop={toggleLoop} duration={ps.duration || transcript.duration} />

      {saidByMenu && (
        <SpeakerMenu
          x={saidByMenu.x}
          y={saidByMenu.y}
          label={t("editor.saidBy")}
          speakers={speakers}
          exclude={saidByMenu.exclude}
          onPick={assignWords}
          onNew={() => assignWords(addSpeaker())}
          onClose={() => setSaidByMenu(null)}
        />
      )}
      {speakerMenu && (
        <SpeakerMenu
          x={speakerMenu.x}
          y={speakerMenu.y}
          speakers={speakers}
          onPick={(id) => setTurnSpeaker(speakerMenu.pos, id)}
          onNew={() => setTurnSpeaker(speakerMenu.pos, addSpeaker())}
          onClose={() => setSpeakerMenu(null)}
        />
      )}
      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        project={details}
        rules={mergeRules(extras.anonymize, studyRules)}
        getTranscript={getTranscript}
        doubts={stats.doubts}
        quotes={quoteSource}
        tab={exportTab}
        onTab={setExportTab}
      />
    </Frame>
  );
}

/** The interview's name in the header: click to rename it, Enter or clicking away saves, Escape cancels. */
function EditableTitle({ value, onSave }: { value: string; onSave: (name: string) => void }) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  // Enter and Escape close the field; the blur that follows must not save a second time.
  const closed = useRef(false);
  if (draft === null) {
    return (
      <Tooltip label={t("editor.rename")}>
        <button
          onClick={() => {
            closed.current = false;
            setDraft(value);
          }}
          className="-mx-1 max-w-full truncate rounded-md px-1 text-left hover:bg-surface-3"
        >
          {value}
        </button>
      </Tooltip>
    );
  }
  const close = (save: boolean) => {
    if (closed.current) return;
    closed.current = true;
    const name = draft.trim();
    setDraft(null);
    if (save && name && name !== value) onSave(name);
  };
  return (
    <input
      autoFocus
      value={draft}
      aria-label={t("editor.rename")}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => close(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") close(true);
        else if (e.key === "Escape") close(false);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
      className="-mx-1 h-6 w-full max-w-md rounded-md border border-accent bg-surface px-1 text-[15px] font-semibold tracking-tight outline-none"
    />
  );
}

type SaveState = "saved" | "saving" | "error";

/** Save status under the title, like document apps show it: everything is saved automatically. */
function SaveStatus({ state, at }: { state: SaveState; at: Date | null }) {
  const t = useT();
  const time = at ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  const tip = state === "error" ? t("editor.saveFailedHint") : time ? t("editor.savedAt", { time }) : t("editor.autoSaveHint");
  return (
    <Tooltip label={tip}>
      <span className={cx("inline-flex items-center gap-1", state === "error" ? "text-danger" : "text-muted")}>
        {state === "saving" ? (
          <Loader2 className="size-3 animate-spin" aria-hidden />
        ) : state === "error" ? (
          <CircleAlert className="size-3" aria-hidden />
        ) : (
          <CircleCheck className="size-3" aria-hidden />
        )}
        {state === "saving" ? t("editor.saving") : state === "error" ? t("editor.saveFailed") : t("editor.autoSaved")}
      </span>
    </Tooltip>
  );
}

function SpeakerMenu({
  x,
  y,
  label,
  speakers,
  exclude,
  onPick,
  onNew,
  onClose,
}: {
  x: number;
  y: number;
  /** Accessible name of the menu; defaults to changing the paragraph's speaker. */
  label?: string;
  speakers: Speaker[];
  /** A speaker not to offer (the paragraph's own); the others keep their colours. */
  exclude?: string;
  onPick: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const t = useT();
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      onClose();
    };
    // Registered after the opening click has finished.
    const id = window.setTimeout(() => {
      window.addEventListener("pointerdown", close);
      window.addEventListener("keydown", close);
      window.addEventListener("wheel", close);
    });
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("wheel", close);
    };
  }, [onClose]);
  return (
    <div
      role="menu"
      aria-label={label ?? t("editor.changeSpeaker")}
      className="anim-pop fixed z-50 min-w-44 rounded-xl border border-line bg-surface p-1 shadow-pop"
      style={{ left: x, top: y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {speakers.map((sp, i) => sp.id === exclude ? null : (
        <button key={sp.id} role="menuitem" onClick={() => onPick(sp.id)} className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm hover:bg-surface-3">
          <span className="size-2.5 rounded-full" style={{ background: `var(--sp${(i % 4) + 1})` }} />
          {sp.name}
        </button>
      ))}
      <div className="my-1 h-px bg-line" />
      <button role="menuitem" onClick={onNew} className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm text-fg-2 hover:bg-surface-3">
        {t("editor.newSpeaker")}
      </button>
    </div>
  );
}

const SPEEDS = [0.5, 0.6, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

function PlayerBar({
  player,
  state,
  stereo,
  speakers,
  duration,
  onToggleLoop,
}: {
  player: Player;
  state: PlayerState;
  stereo: boolean;
  speakers: Speaker[];
  duration: number;
  onToggleLoop: () => void;
}) {
  const t = useT();
  const pct = duration > 0 ? Math.min(100, (state.time / duration) * 100) : 0;
  const speeds = SPEEDS.includes(state.rate) ? SPEEDS : [...SPEEDS, state.rate].sort((a, b) => a - b);
  return (
    <div className="flex h-16 shrink-0 items-center gap-2 border-t border-line bg-surface px-4">
      <IconButton label={t("editor.back5")} shortcut="Alt+←" onClick={() => player.skip(-5)}>
        <RotateCcw className="size-[18px]" />
      </IconButton>
      <Tooltip label={state.playing ? t("editor.pause") : t("editor.play")} shortcut="Esc / ⏯">
        <button
          onClick={() => player.toggle()}
          aria-label={state.playing ? t("editor.pause") : t("editor.play")}
          className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg shadow-card transition-colors hover:bg-accent-hover"
        >
          {state.playing ? <Pause className="size-[18px] fill-current" /> : <Play className="ml-0.5 size-[18px] fill-current" />}
        </button>
      </Tooltip>
      <IconButton label={t("editor.forward5")} shortcut="Alt+→" onClick={() => player.skip(5)}>
        <RotateCw className="size-[18px]" />
      </IconButton>

      <span className="tabular w-[104px] shrink-0 text-center text-xs text-fg-2">
        {formatClock(state.time)} <span className="text-muted">/ {formatClock(duration)}</span>
      </span>

      <input
        type="range"
        min={0}
        max={Math.max(1, duration)}
        step={0.1}
        value={Math.min(state.time, duration)}
        onChange={(e) => player.seek(Number(e.target.value))}
        aria-label={t("editor.play")}
        className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:shadow"
        style={{ background: `linear-gradient(to right, var(--accent) ${pct}%, var(--surface-3) ${pct}%)` }}
      />

      <Tooltip label={t("editor.speed")} shortcut="Alt+↑↓">
        <span>
          <Select value={state.rate} onChange={(e) => player.setRate(Number(e.target.value))} aria-label={t("editor.speed")} className="tabular h-8 w-[88px]">
            {speeds.map((s) => (
              <option key={s} value={s}>
                {s.toFixed(2).replace(/0$/, "")}×
              </option>
            ))}
          </Select>
        </span>
      </Tooltip>
      <IconButton label={t("editor.loop")} shortcut={`${MOD}+L`} active={state.loop !== null} onClick={onToggleLoop}>
        <Repeat className="size-[18px]" />
      </IconButton>
      <IconButton label={`${t("editor.clarity")} — ${t("editor.clarityHint")}`} active={state.clarity} onClick={() => player.setClarity(!state.clarity)}>
        <Sparkles className="size-[18px]" />
      </IconButton>
      {stereo && (
        <Tooltip label={t("editor.listen")}>
          <span className="flex items-center gap-1.5">
            <AudioLines className="size-4 text-muted" />
            <Segmented<Listen>
              size="sm"
              value={state.listen}
              onChange={(v) => player.setListen(v)}
              options={[
                { value: "both", label: t("editor.listenBoth") },
                { value: "left", label: "1", title: speakers[0]?.name },
                { value: "right", label: "2", title: speakers[1]?.name },
              ]}
            />
          </span>
        </Tooltip>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ find and replace

function SearchBar({ editor, focus, onClose }: { editor: TipTapEditor; focus: number; onClose: () => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [whole, setWhole] = useState(false);
  const [, rerender] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Whether the user has moved to a hit since the query last changed.
  const moved = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focus]);

  useEffect(() => {
    moved.current = false;
    editor.view.dispatch(editor.state.tr.setMeta(highlightKey, { searchQuery: { query, wholeWord: whole } }));
  }, [editor, query, whole]);

  // Clear the highlights when the bar closes.
  useEffect(
    () => () => {
      if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(highlightKey, { searchQuery: { query: "", wholeWord: false } }));
    },
    [editor],
  );

  // Hit counts change with every edit.
  useEffect(() => {
    const on = () => rerender((n) => n + 1);
    editor.on("transaction", on);
    return () => {
      editor.off("transaction", on);
    };
  }, [editor]);

  const state = highlightKey.getState(editor.state)?.search;
  const hits = state?.hits ?? [];
  const current = state?.current ?? -1;

  const goTo = (delta: number) => {
    const n = hits.length;
    if (n === 0) return;
    const i = moved.current ? (current + delta + n) % n : delta > 0 ? Math.max(0, current) : (Math.max(0, current) - 1 + n) % n;
    moved.current = true;
    const h = hits[i];
    editor.view.dispatch(
      editor.state.tr.setMeta(highlightKey, { searchCurrent: i }).setSelection(TextSelection.create(editor.state.doc, h.from, h.to)).scrollIntoView(),
    );
  };

  /** Replace one range, keeping the audio link of the text it replaces. */
  const replaceRange = (tr: ReturnType<typeof editor.state.tr.setMeta>, from: number, to: number) => {
    const marks = editor.state.doc.resolve(from + 1).marks();
    return replacement ? tr.replaceWith(from, to, editor.state.schema.text(replacement, marks)) : tr.delete(from, to);
  };

  const replaceOne = () => {
    if (current < 0 || !hits[current]) return;
    const h = hits[current];
    editor.view.dispatch(replaceRange(editor.state.tr, h.from, h.to).scrollIntoView());
    moved.current = false;
  };

  const replaceAll = () => {
    if (hits.length === 0) return;
    let tr = editor.state.tr;
    for (const h of [...hits].reverse()) tr = replaceRange(tr, h.from, h.to);
    editor.view.dispatch(tr);
    useApp.getState().toast(t("editor.applied", { n: hits.length }), "ok", { label: t("common.undo"), run: () => editor.commands.undo() });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      editor.view.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      goTo(e.shiftKey ? -1 : 1);
    }
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-3 py-2">
      <Search className="size-4 shrink-0 text-muted" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKey}
        placeholder={t("editor.find")}
        aria-label={t("editor.find")}
        className="h-8 w-56 rounded-lg border border-line-strong bg-surface px-2.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
      />
      <span className="tabular w-20 text-xs text-muted">
        {query.trim() ? (hits.length ? t("editor.hitOf", { i: current + 1, n: hits.length }) : t("editor.noHits")) : ""}
      </span>
      <IconButton label={t("editor.prevHit")} shortcut="Shift+Enter" size="sm" onClick={() => goTo(-1)} disabled={hits.length === 0}>
        <ChevronLeft className="size-4" />
      </IconButton>
      <IconButton label={t("editor.nextHit")} shortcut="Enter" size="sm" onClick={() => goTo(1)} disabled={hits.length === 0}>
        <ChevronRight className="size-4" />
      </IconButton>
      <label className="flex items-center gap-1.5 text-xs text-fg-2">
        <input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} className="accent-[var(--accent)]" />
        {t("editor.wholeWord")}
      </label>
      <div className="mx-1 h-5 w-px bg-line" />
      <input
        value={replacement}
        onChange={(e) => setReplacement(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onKey(e);
          else if (e.key === "Enter") {
            e.preventDefault();
            replaceOne();
          }
        }}
        placeholder={t("editor.replaceWith")}
        aria-label={t("editor.replaceWith")}
        className="h-8 w-48 rounded-lg border border-line-strong bg-surface px-2.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
      />
      <Button size="sm" variant="ghost" onClick={replaceOne} disabled={current < 0 || hits.length === 0}>
        {t("editor.replaceOne")}
      </Button>
      <Button size="sm" variant="ghost" onClick={replaceAll} disabled={hits.length === 0}>
        {t("editor.replaceAllN", { n: hits.length })}
      </Button>
      <div className="flex-1" />
      <IconButton label={t("common.close")} size="sm" onClick={onClose}>
        <X className="size-4" />
      </IconButton>
    </div>
  );
}
