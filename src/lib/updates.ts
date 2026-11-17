// Updates from GitHub Releases through Tauri's updater: a check at startup (unless turned off in
// Settings) and a one-click download, signature check, install and restart.
//
// The check fetches a small JSON file (latest.json) from the project's GitHub Releases. No
// recordings, transcripts or other user data are sent. When offline the check fails silently.

import type { Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import { isTauri } from "./api";

type Phase = "idle" | "checking" | "available" | "downloading" | "installing" | "error";

interface UpdateState {
  phase: Phase;
  version: string | null;
  /** 0..1 while downloading, when the size is known. */
  progress: number | null;
  error: string | null;
  /** Hidden for this session by "Later". */
  dismissed: boolean;
  /** Look for a newer version. Resolves to whether one was found ("error" if the check failed). */
  check: () => Promise<"none" | "available" | "error">;
  /** Download, verify and install the update, then restart the app. */
  install: () => Promise<void>;
  dismiss: () => void;
}

let pending: Update | null = null;

export const useUpdates = create<UpdateState>((set, get) => ({
  phase: "idle",
  version: null,
  progress: null,
  error: null,
  dismissed: false,

  check: async () => {
    if (!isTauri) return "none";
    if (get().phase === "downloading" || get().phase === "installing") return "available";
    set({ phase: "checking", error: null });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check({ timeout: 15_000 });
      if (!update) {
        set({ phase: "idle" });
        return "none";
      }
      pending = update;
      set({ phase: "available", version: update.version, dismissed: false });
      return "available";
    } catch (e) {
      set({ phase: "idle", error: String(e) });
      return "error";
    }
  },

  install: async () => {
    if (!pending) return;
    set({ phase: "downloading", progress: null, error: null });
    try {
      let total = 0;
      let received = 0;
      await pending.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        if (event.event === "Progress") {
          received += event.data.chunkLength;
          if (total > 0) set({ progress: Math.min(1, received / total) });
        }
        if (event.event === "Finished") set({ phase: "installing", progress: 1 });
      });
      // On Windows the installer closes the app itself; elsewhere restart into the new version.
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      set({ phase: "error", error: String(e) });
    }
  },

  dismiss: () => set({ dismissed: true }),
}));
