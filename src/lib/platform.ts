// Native dialogs and file drops, with harmless fallbacks for browser development.

import { isTauri } from "./api";

export const AUDIO_EXTENSIONS = ["m4a", "mp3", "wav", "aac", "ogg", "oga", "opus", "flac", "wma", "aiff", "aif", "amr", "caf", "mp4", "mov", "mkv", "webm", "m4v", "3gp"];

export function isAudioPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXTENSIONS.includes(ext);
}

/** Ask the user for one or more recordings. Returns absolute paths (empty if cancelled). */
export async function pickAudioFiles(multiple: boolean): Promise<string[]> {
  if (!isTauri) return multiple ? ["C:/mock/interview-a.m4a", "C:/mock/interview-b.m4a"] : ["C:/mock/interview.m4a"];
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ multiple, filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }] });
  if (!picked) return [];
  return Array.isArray(picked) ? picked : [picked];
}

/** Ask where to save a file. Returns the chosen path or null. */
export async function pickSavePath(defaultName: string, extension: string): Promise<string | null> {
  if (!isTauri) return `C:/mock/${defaultName}`;
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ defaultPath: defaultName, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] });
}

/** Ask for a folder (for example to export a whole study into). */
export async function pickFolder(): Promise<string | null> {
  if (!isTauri) return "C:/mock/export";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false });
  return typeof picked === "string" ? picked : null;
}

/** Ask for a single file of the given kind (used for importing a model file). */
export async function pickFile(name: string, extensions: string[]): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ multiple: false, filters: [{ name, extensions }] });
  return typeof picked === "string" ? picked : null;
}

export interface DropHandlers {
  onHover?: (hovering: boolean) => void;
  onDrop: (paths: string[]) => void;
}

/** Listen for files dragged onto the window. Returns an unsubscribe function. */
export function onFileDrop(handlers: DropHandlers): () => void {
  if (!isTauri) return () => {};
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  void import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
    const un = await getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter" || p.type === "over") handlers.onHover?.(true);
      else if (p.type === "leave") handlers.onHover?.(false);
      else if (p.type === "drop") {
        handlers.onHover?.(false);
        const audio = p.paths.filter(isAudioPath);
        if (audio.length > 0) handlers.onDrop(audio);
      }
    });
    if (cancelled) un();
    else unlisten = un;
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
