// Dragging an annotation from the tool row or the side panel into the text.
//
// Pointer events, not HTML5 drag-and-drop: in the desktop app the window itself takes
// drag-and-drop (for audio files dropped from the file manager), so HTML5 drag events never
// reach the page there. While dragging, a label follows the pointer and a caret shows where the
// annotation will go; Escape cancels.

import type { EditorView } from "@tiptap/pm/view";
import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";

/** Pointer travel (px) before a press on an annotation becomes a drag instead of a click. */
const THRESHOLD = 5;

/** Where an annotation dropped at (x, y) goes: between words, or null outside the text. */
export function dropPosition(view: EditorView, x: number, y: number): number | null {
  const hit = view.posAtCoords({ left: x, top: y });
  if (!hit) return null;
  const { doc } = view.state;
  const $pos = doc.resolve(hit.pos);
  if (!$pos.parent.isTextblock) return null;
  // Dropped inside a word: move to the end of that word.
  const isWordChar = (p: number) => /[\p{L}\p{N}]/u.test(doc.textBetween(p, p + 1, "\n"));
  let pos = hit.pos;
  if (pos > $pos.start() && isWordChar(pos - 1)) while (pos < $pos.end() && isWordChar(pos)) pos++;
  return pos;
}

export interface TagDrag {
  /** onPointerDown of an annotation button. */
  start: (tag: string, e: ReactPointerEvent) => void;
  /** Call in onClick: true when the press was a drag, so the click must not insert. */
  wasDrag: () => boolean;
}

export function useTagDrag(getView: () => EditorView | null, onDrop: (tag: string, pos: number) => void): TagDrag {
  const dragged = useRef(false);

  const start = useCallback(
    (tag: string, e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      dragged.current = false;
      const x0 = e.clientX;
      const y0 = e.clientY;
      let ghost: HTMLDivElement | null = null;
      let caret: HTMLDivElement | null = null;
      let target: number | null = null;

      const move = (ev: PointerEvent) => {
        if (!ghost) {
          if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < THRESHOLD) return;
          ghost = document.createElement("div");
          ghost.className = "tag-drag-ghost";
          ghost.textContent = tag;
          caret = document.createElement("div");
          caret.className = "tag-drag-caret";
          document.body.append(ghost, caret);
          document.body.classList.add("tag-dragging");
          dragged.current = true;
        }
        ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 10}px)`;
        const view = getView();
        target = view ? dropPosition(view, ev.clientX, ev.clientY) : null;
        if (view && target != null && caret) {
          const c = view.coordsAtPos(target);
          caret.style.display = "block";
          caret.style.transform = `translate(${c.left - 1}px, ${c.top}px)`;
          caret.style.height = `${c.bottom - c.top}px`;
        } else if (caret) {
          caret.style.display = "none";
        }
      };
      const finish = (drop: boolean) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", key, true);
        ghost?.remove();
        caret?.remove();
        document.body.classList.remove("tag-dragging");
        if (drop && ghost && target != null) onDrop(tag, target);
      };
      const up = () => finish(true);
      const cancel = () => finish(false);
      const key = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape" || !ghost) return;
        ev.preventDefault();
        ev.stopPropagation();
        finish(false);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", key, true);
    },
    [getView, onDrop],
  );

  const wasDrag = useCallback(() => {
    const d = dragged.current;
    dragged.current = false;
    return d;
  }, []);

  return { start, wasDrag };
}
