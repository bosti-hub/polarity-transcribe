// The transcript as a ProseMirror document, and the conversions to and from the stored model.
//
// Every speaker turn is a `turn` node. Its content is plain text in which each recognised
// item (word, filler, pause tag, backchannel, note) carries a `timing` mark with its audio
// position and confidence. Because everything is ordinary text, people can correct, delete
// and retype freely; the marks keep the link to the audio for whatever text remains.

import { Mark, mergeAttributes, Node } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { PAUSE_RE, pauseLabel } from "@/lib/transcript";
import type { Item, Paragraph, Speaker, Transcript } from "@/lib/types";

/** Kind of text a timing mark covers. */
export type TimingKind = "w" | "f" | "p" | "b" | "n";

export interface TimingAttrs {
  /** Start / end in seconds. */
  s: number;
  e: number;
  /** Confidence 0..1. */
  c: number;
  k: TimingKind;
  /** Speaker id, for backchannels. */
  sp: string | null;
}

export const Timing = Mark.create({
  name: "timing",
  // Typing inside or at the end of a word keeps it one word with the same audio position.
  inclusive: true,
  excludes: "timing",

  addAttributes() {
    const num = (name: string, fallback: number) => ({
      default: fallback,
      parseHTML: (el: HTMLElement) => Number(el.getAttribute(`data-${name}`) ?? fallback),
      renderHTML: (attrs: Record<string, unknown>) => ({ [`data-${name}`]: String(attrs[name]) }),
    });
    return {
      s: num("s", 0),
      e: num("e", 0),
      c: num("c", 1),
      k: {
        default: "w",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-k") ?? "w",
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-k": attrs.k as string }),
      },
      sp: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-sp"),
        renderHTML: (attrs: Record<string, unknown>) => (attrs.sp ? { "data-sp": attrs.sp as string } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-k]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "tw" }), 0];
  },
});

export interface TurnViewHost {
  speakerName: (id: string) => string;
  speakerIndex: (id: string) => number;
  /** Called when the speaker label of a turn is clicked. */
  onSpeakerClick: (pos: number, anchor: HTMLElement) => void;
  formatTime: (seconds: number) => string;
  onTimeClick: (seconds: number) => void;
}

/** Views register here so labels can be refreshed when a speaker is renamed. */
export const turnViews = new Set<{ refresh: () => void }>();

function firstTime(node: PMNode): number | null {
  let t: number | null = null;
  node.descendants((child) => {
    if (t !== null) return false;
    const mark = child.marks.find((m) => m.type.name === "timing");
    if (mark && (mark.attrs.k === "w" || mark.attrs.k === "f")) t = mark.attrs.s as number;
    return true;
  });
  return t;
}

export function createTurn(host: TurnViewHost) {
  return Node.create({
    name: "turn",
    group: "block",
    content: "inline*",
    defining: true,

    addAttributes() {
      return {
        speaker: {
          default: "S1",
          parseHTML: (el: HTMLElement) => el.getAttribute("data-speaker") ?? "S1",
          renderHTML: (attrs: Record<string, unknown>) => ({ "data-speaker": attrs.speaker as string }),
        },
      };
    },

    parseHTML() {
      return [{ tag: "div[data-speaker]" }];
    },

    renderHTML({ HTMLAttributes }) {
      return ["div", mergeAttributes(HTMLAttributes, { class: "turn" }), 0];
    },

    addNodeView() {
      return ({ node, getPos }) => {
        let current = node;
        const dom = document.createElement("div");
        dom.className = "turn";
        const head = document.createElement("div");
        head.className = "turn-head";
        head.contentEditable = "false";
        const name = document.createElement("button");
        name.type = "button";
        name.className = "turn-speaker";
        const time = document.createElement("button");
        time.type = "button";
        time.className = "turn-time";
        head.append(name, time);
        const content = document.createElement("div");
        content.className = "turn-text";
        dom.append(head, content);

        const refresh = () => {
          const id = current.attrs.speaker as string;
          name.textContent = host.speakerName(id);
          dom.dataset.sp = String((host.speakerIndex(id) % 4) + 1);
          const t = firstTime(current);
          time.textContent = t === null ? "" : host.formatTime(t);
          time.dataset.t = t === null ? "" : String(t);
        };
        refresh();

        // mousedown would move the text cursor into the label; the click is what we want.
        head.addEventListener("mousedown", (e) => e.preventDefault());
        name.addEventListener("click", () => {
          const pos = getPos();
          if (typeof pos === "number") host.onSpeakerClick(pos, name);
        });
        time.addEventListener("click", () => {
          if (time.dataset.t) host.onTimeClick(Number(time.dataset.t));
        });

        const view = { refresh };
        turnViews.add(view);
        return {
          dom,
          contentDOM: content,
          update(updated) {
            if (updated.type !== current.type) return false;
            current = updated;
            refresh();
            return true;
          },
          destroy() {
            turnViews.delete(view);
          },
          ignoreMutation(mutation) {
            // The header is ours; ProseMirror only needs to watch the text.
            return !content.contains(mutation.target);
          },
        };
      };
    },
  });
}

// ------------------------------------------------------------------ model → document

interface JSONNode {
  type: string;
  attrs?: Record<string, unknown>;
  text?: string;
  marks?: { type: string; attrs: TimingAttrs }[];
  content?: JSONNode[];
}

function itemNode(item: Item, t: Pick<Transcript, "speakers" | "language">): JSONNode {
  const mark = (attrs: TimingAttrs) => [{ type: "timing", attrs }];
  switch (item.k) {
    case "w":
      return { type: "text", text: item.t, marks: mark({ s: item.s, e: item.e, c: item.c, k: item.f ? "f" : "w", sp: null }) };
    case "p":
      return { type: "text", text: pauseLabel(t.language, item.e - item.s), marks: mark({ s: item.s, e: item.e, c: 1, k: "p", sp: null }) };
    case "b": {
      const name = t.speakers.find((s) => s.id === item.sp)?.name ?? item.sp;
      return { type: "text", text: `[${name}: ${item.t}]`, marks: mark({ s: item.s, e: item.e, c: 1, k: "b", sp: item.sp }) };
    }
    case "n":
      return { type: "text", text: item.t, marks: mark({ s: item.s ?? 0, e: item.s ?? 0, c: 1, k: "n", sp: null }) };
  }
}

export function toDoc(transcript: Transcript): JSONNode {
  const turns: JSONNode[] = transcript.paragraphs.map((p) => {
    const content: JSONNode[] = [];
    p.items.forEach((item, i) => {
      if (i > 0) content.push({ type: "text", text: " " });
      const node = itemNode(item, transcript);
      if (node.text) content.push(node);
    });
    return { type: "turn", attrs: { speaker: p.speaker }, content };
  });
  if (turns.length === 0) turns.push({ type: "turn", attrs: { speaker: transcript.speakers[0]?.id ?? "S1" }, content: [] });
  return { type: "doc", content: turns };
}

// ------------------------------------------------------------------ document → model

const TOKEN_RE = /\[[^\]\n]*\]\S*|\S+/g;
const BRACKETED_RE = /^\[[^\]]*\][.,;:!?…]*$/;
const BACKCHANNEL_RE = /^\[[^:\]]+: ([^\]]*)\]/;

const round = (v: number) => Math.round(v * 1000) / 1000;

function turnItems(turn: PMNode): Item[] {
  // Paragraph text with, per character, the timing mark that covers it.
  let text = "";
  const marks: (TimingAttrs | null)[] = [];
  turn.forEach((child) => {
    if (!child.isText || !child.text) return;
    const mark = child.marks.find((m) => m.type.name === "timing");
    text += child.text;
    for (let i = 0; i < child.text.length; i++) marks.push(mark ? (mark.attrs as TimingAttrs) : null);
  });

  const items: Item[] = [];
  let lastEnd = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    const token = match[0];
    const from = match.index;
    let attrs: TimingAttrs | null = null;
    for (let i = from; i < from + token.length && !attrs; i++) attrs = marks[i];

    if (attrs?.k === "p" && PAUSE_RE.test(token.replace(/[.,;:!?…]+$/, ""))) {
      items.push({ k: "p", s: round(attrs.s), e: round(attrs.e) });
      lastEnd = attrs.e;
    } else if (attrs?.k === "b" && attrs.sp && BACKCHANNEL_RE.test(token)) {
      items.push({ k: "b", sp: attrs.sp, t: BACKCHANNEL_RE.exec(token)![1], s: round(attrs.s), e: round(attrs.e) });
    } else if (BRACKETED_RE.test(token) && (!attrs || attrs.k !== "f")) {
      items.push({ k: "n", t: token, s: round(attrs && attrs.k === "n" ? attrs.s : lastEnd) });
    } else if (attrs && (attrs.k === "w" || attrs.k === "f")) {
      items.push({ k: "w", t: token, s: round(attrs.s), e: round(attrs.e), c: attrs.c, ...(attrs.k === "f" ? { f: true } : {}) });
      lastEnd = attrs.e;
    } else {
      // Typed by a person where no recognised word was: it takes the position reached so far.
      items.push({ k: "w", t: token, s: round(lastEnd), e: round(lastEnd), c: 1 });
    }
  }
  return items;
}

/** Read the edited document back into the stored transcript model. */
export function fromDoc(doc: PMNode, base: Pick<Transcript, "language" | "duration">, speakers: Speaker[]): Transcript {
  const paragraphs: Paragraph[] = [];
  let clock = 0;
  doc.forEach((turn) => {
    if (turn.type.name !== "turn") return;
    const items = turnItems(turn);
    if (items.length === 0) return;
    const times = items.filter((i): i is Exclude<Item, { k: "n" }> => i.k !== "n");
    const start = times.length > 0 ? Math.min(...times.map((i) => i.s)) : clock;
    const end = times.length > 0 ? Math.max(...times.map((i) => i.e)) : clock;
    clock = Math.max(clock, end);
    paragraphs.push({ id: `p${paragraphs.length + 1}`, speaker: turn.attrs.speaker as string, start: round(start), end: round(end), items });
  });
  return { version: 1, language: base.language, duration: base.duration, speakers, paragraphs };
}
