// Application-wide state: navigation, settings, models, running jobs and toasts.

import { create } from "zustand";
import { api, errorMessage, events } from "./api";
import type { AppInfo, DownloadProgress, JobProgress, ModelInfo, Settings, Study } from "./types";
import { useUpdates } from "./updates";

export type Route =
  | { name: "home" }
  | { name: "setup"; id: string }
  | { name: "progress"; id: string }
  | { name: "editor"; id: string; at?: number }
  | { name: "settings" }
  | { name: "help" };

export interface Toast {
  id: number;
  message: string;
  tone: "info" | "ok" | "error";
  action?: { label: string; run: () => void };
}

export const DEFAULT_SETTINGS: Settings = {
  uiLanguage: "nl",
  theme: "system",
  model: null,
  fastMode: false,
  threads: 0,
  useGpu: true,
  showDoubts: true,
  doubtThreshold: 0.5,
  onboarded: false,
  checkUpdates: true,
  rewindSeconds: 1.5,
  keyPlayPause: "",
  keyBack: "",
  keyForward: "",
  spellcheck: false,
};

interface AppState {
  ready: boolean;
  info: AppInfo | null;
  settings: Settings;
  models: ModelInfo[];
  downloads: Record<string, DownloadProgress>;
  jobs: Record<string, JobProgress>;
  route: Route;
  toasts: Toast[];
  /** Files chosen on the home screen, waiting to be imported by the setup screen. */
  pendingImports: Record<string, string[]>;
  /** What the library shows: "all" interviews or one study (by id). */
  library: string;
  studies: Study[];
  /** Interviews waiting to be transcribed after the running one. */
  queue: string[];
  /** Background imports started from the library: fraction per interview id. */
  importing: Record<string, number>;

  init: () => Promise<void>;
  queueImports: (projectId: string, paths: string[]) => void;
  takeImports: (projectId: string) => string[];
  go: (route: Route) => void;
  /** Where Settings and the manual return to: the screen they were opened from. */
  backRoute: Route;
  goBack: () => void;
  updateSettings: (patch: Partial<Settings>) => void;
  refreshModels: () => Promise<void>;
  /** Show a message; returns its id, for `dismissToast`. */
  toast: (message: string, tone?: Toast["tone"], action?: Toast["action"]) => number;
  dismissToast: (id: number) => void;
  showLibrary: (view: string) => void;
  refreshStudies: () => Promise<Study[]>;
  /** Replace one study in the list after a change. */
  putStudy: (study: Study) => void;
  /** Import recordings into interviews one after another, in the background. */
  importInBackground: (jobs: { projectId: string; path: string }[]) => void;
}

const LIBRARY_KEY = "pt.library";

function savedLibrary(): string {
  try {
    return localStorage.getItem(LIBRARY_KEY) ?? "all";
  } catch {
    return "all";
  }
}

/** Imports run one at a time: each decodes a whole recording and uses several cores. */
let importChain: Promise<void> = Promise.resolve();

let toastId = 0;

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  info: null,
  settings: DEFAULT_SETTINGS,
  models: [],
  downloads: {},
  jobs: {},
  route: { name: "home" },
  toasts: [],
  pendingImports: {},
  library: savedLibrary(),
  studies: [],
  queue: [],
  importing: {},

  queueImports: (projectId, paths) => set((s) => ({ pendingImports: { ...s.pendingImports, [projectId]: paths } })),
  takeImports: (projectId) => {
    const paths = get().pendingImports[projectId] ?? [];
    if (paths.length > 0) {
      set((s) => {
        const { [projectId]: _taken, ...rest } = s.pendingImports;
        return { pendingImports: rest };
      });
    }
    return paths;
  },

  init: async () => {
    const [info, settings, models] = await Promise.all([api.appInfo(), api.getSettings(), api.listModels()]);
    const merged = { ...DEFAULT_SETTINGS, ...settings };
    // First start: follow the system language.
    if (!merged.onboarded) merged.uiLanguage = navigator.language.toLowerCase().startsWith("nl") ? "nl" : "en";
    set({ info, settings: merged, models, ready: true });

    void events.downloadProgress((p) => {
      set((s) => ({ downloads: { ...s.downloads, [p.id]: p } }));
      if (p.state !== "downloading" && p.state !== "verifying") void get().refreshModels();
    });
    void events.jobProgress((p) => {
      set((s) => ({ jobs: { ...s.jobs, [p.projectId]: p } }));
    });
    void events.queueChanged((queue) => set({ queue }));
    void events.importProgress((p) => {
      if (p.projectId in get().importing) set((s) => ({ importing: { ...s.importing, [p.projectId]: p.fraction } }));
    });
    void api.jobQueue().then((queue) => set({ queue }), () => {});
    const studies = await get().refreshStudies().catch(() => []);
    const library = get().library;
    if (library !== "all" && !studies.some((s) => s.id === library)) get().showLibrary("all");

    // Look for a newer version shortly after startup, out of the way of the first screen.
    if (merged.checkUpdates) {
      setTimeout(() => void useUpdates.getState().check(), 4_000);
    }
  },

  go: (route) =>
    set((s) => ({
      route,
      // Settings and the manual are side trips: remember where they were opened from.
      backRoute: route.name === "settings" || route.name === "help" ? (s.route.name === "settings" || s.route.name === "help" ? s.backRoute : s.route) : s.backRoute,
    })),
  backRoute: { name: "home" },
  goBack: () => set((s) => ({ route: s.backRoute })),

  updateSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    api.setSettings(settings).catch((e) => get().toast(errorMessage(e), "error"));
  },

  refreshModels: async () => {
    set({ models: [...(await api.listModels())] });
  },

  toast: (message, tone = "info", action) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, message, tone, action }] }));
    setTimeout(() => get().dismissToast(id), tone === "error" ? 9000 : 5000);
    return id;
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  showLibrary: (view) => {
    try {
      localStorage.setItem(LIBRARY_KEY, view);
    } catch {
      // Remembering the view is a convenience only.
    }
    set({ library: view, route: { name: "home" } });
  },

  refreshStudies: async () => {
    const studies = await api.listStudies();
    set({ studies });
    return studies;
  },

  putStudy: (study) =>
    set((s) => ({
      studies: s.studies.some((x) => x.id === study.id) ? s.studies.map((x) => (x.id === study.id ? study : x)) : [...s.studies, study],
    })),

  importInBackground: (jobs) => {
    set((s) => ({ importing: { ...s.importing, ...Object.fromEntries(jobs.map((j) => [j.projectId, 0])) } }));
    for (const job of jobs) {
      importChain = importChain.then(async () => {
        try {
          await api.importAudio(job.projectId, 0, job.path);
        } catch (e) {
          get().toast(errorMessage(e), "error");
        } finally {
          set((s) => {
            const { [job.projectId]: _done, ...rest } = s.importing;
            return { importing: rest };
          });
        }
      });
    }
  },
}));

/** The installed model that new transcriptions will use, if any. */
export function activeModel(models: ModelInfo[], settings: Settings): ModelInfo | null {
  const installed = models.filter((m) => m.installed);
  return installed.find((m) => m.id === settings.model) ?? installed.find((m) => m.recommended) ?? installed[0] ?? null;
}
