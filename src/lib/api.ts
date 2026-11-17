// Thin, typed wrappers around the Tauri commands exposed by src-tauri.

import { convertFileSrc, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { mockInvoke, mockListen } from "./mock";
import type {
  AppInfo,
  DownloadProgress,
  JobProgress,
  Language,
  ModelInfo,
  Project,
  ProjectExtras,
  ProjectPatch,
  Settings,
  Study,
  StudyPatch,
  Participant,
  Transcript,
} from "./types";

/** False when the UI runs in a plain browser for development; a mock backend is used then. */
export const isTauri = "__TAURI_INTERNALS__" in window;

type UnlistenFn = () => void;

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return isTauri ? tauriInvoke<T>(cmd, args) : (mockInvoke(cmd, args) as Promise<T>);
}

function listen<T>(event: string, cb: (e: { payload: T }) => void): Promise<UnlistenFn> {
  if (isTauri) return tauriListen<T>(event, cb);
  return Promise.resolve(mockListen(event, (payload) => cb({ payload: payload as T })));
}

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),

  getSettings: () => invoke<Settings>("get_settings"),
  setSettings: (settings: Settings) => invoke<void>("set_settings", { settings }),

  listProjects: () => invoke<Project[]>("list_projects"),
  createProject: (name: string, language: Language, studyId: string | null = null) =>
    invoke<Project>("create_project", { name, language, studyId }),
  getProject: (id: string) => invoke<Project>("get_project", { id }),
  updateProject: (id: string, patch: ProjectPatch) => invoke<Project>("update_project", { id, patch }),
  deleteProject: (id: string) => invoke<void>("delete_project", { id }),

  importAudio: (id: string, slot: number, path: string) => invoke<Project>("import_audio", { id, slot, path }),
  cancelImport: (id: string, slot: number) => invoke<void>("cancel_import", { id, slot }),
  removeAudio: (id: string, slot: number) => invoke<Project>("remove_audio", { id, slot }),
  /** Waveform peaks: one byte per 20 ms, square-root companded (0..255). */
  readPeaks: async (id: string, slot: number, right: boolean) =>
    new Uint8Array(await invoke<ArrayBuffer>("read_peaks", { id, slot, right })),
  /** Offset between the two recordings in seconds (file 2 time = file 1 time + offset), or null. */
  quickSync: (id: string) => invoke<number | null>("quick_sync", { id }),

  listModels: () => invoke<ModelInfo[]>("list_models"),
  downloadModel: (id: string) => invoke<void>("download_model", { id }),
  cancelDownload: (id: string) => invoke<void>("cancel_download", { id }),
  deleteModel: (id: string) => invoke<void>("delete_model", { id }),
  importModel: (id: string, path: string) => invoke<void>("import_model", { id, path }),

  startJob: (id: string) => invoke<void>("start_job", { id }),
  /** Transcribe several interviews one after another. */
  queueJobs: (ids: string[]) => invoke<void>("queue_jobs", { ids }),
  jobQueue: () => invoke<string[]>("job_queue"),

  listStudies: () => invoke<Study[]>("list_studies"),
  createStudy: (name: string, language: Language) => invoke<Study>("create_study", { name, language }),
  updateStudy: (id: string, patch: StudyPatch) => invoke<Study>("update_study", { id, patch }),
  /** Delete a study; its interviews are deleted too or kept without a study. */
  deleteStudy: (id: string, deleteInterviews: boolean) => invoke<void>("delete_study", { id, deleteInterviews }),
  /** Add (empty id) or replace a participant. */
  saveParticipant: (studyId: string, participant: Participant) => invoke<Study>("save_participant", { studyId, participant }),
  deleteParticipant: (studyId: string, participantId: string) => invoke<Study>("delete_participant", { studyId, participantId }),
  cancelJob: (id: string) => invoke<void>("cancel_job", { id }),
  jobStatus: (id: string) => invoke<JobProgress | null>("job_status", { id }),

  loadTranscript: (id: string) => invoke<Transcript>("load_transcript", { id }),
  saveTranscript: (id: string, transcript: Transcript) => invoke<void>("save_transcript", { id, transcript }),
  loadExtras: (id: string) => invoke<ProjectExtras>("load_extras", { id }),
  saveExtras: (id: string, extras: ProjectExtras) => invoke<void>("save_extras", { id, extras }),
  loadReport: (id: string) => invoke<Record<string, unknown> | null>("load_report", { id }),

  /** Write an exported file to a path the user picked in the save dialog. */
  writeFile: (path: string, bytes: Uint8Array) => invoke<void>("write_file", { path, bytes: Array.from(bytes) }),
  revealInFolder: (path: string) => invoke<void>("reveal_in_folder", { path }),
  /** Cut a passage into its own audio file; `bleeps` are spans (transcript timeline) to beep out. */
  exportClip: (id: string, start: number, end: number, dest: string, voice: "tv" | "whisper" | null, bleeps: [number, number][] = []) =>
    invoke<void>("export_clip", { id, start, end, dest, voice, bleeps }),
  openProjectPage: (page: "home" | "issues" | "license") => invoke<void>("open_project_page", { page }),
  /** Copy an interview's original recording to `dest`; false when the original no longer exists. */
  copyOriginal: (id: string, dest: string) => invoke<boolean>("copy_original", { id, dest }),
};

/** URL the webview can load for a file inside a project folder. */
export function projectFileUrl(project: Pick<Project, "dir">, name: string, cacheKey?: number | string): string {
  if (!isTauri) return mockAudioUrl();
  const sep = project.dir.includes("\\") ? "\\" : "/";
  const url = convertFileSrc(`${project.dir}${sep}${name}`);
  return cacheKey === undefined ? url : `${url}?v=${cacheKey}`;
}

export interface ImportProgress {
  projectId: string;
  slot: number;
  fraction: number;
}

export const events = {
  importProgress: (cb: (p: ImportProgress) => void): Promise<UnlistenFn> =>
    listen<ImportProgress>("import-progress", (e) => cb(e.payload)),
  jobProgress: (cb: (p: JobProgress) => void): Promise<UnlistenFn> =>
    listen<JobProgress>("job-progress", (e) => cb(e.payload)),
  downloadProgress: (cb: (p: DownloadProgress) => void): Promise<UnlistenFn> =>
    listen<DownloadProgress>("download-progress", (e) => cb(e.payload)),
  /** Interviews waiting to be transcribed, in order. */
  queueChanged: (cb: (ids: string[]) => void): Promise<UnlistenFn> => listen<string[]>("queue-changed", (e) => cb(e.payload)),
  /** A choice in the macOS menu bar that the web UI handles ("help", "settings"). */
  menu: (cb: (id: string) => void): Promise<UnlistenFn> => listen<string>("menu", (e) => cb(e.payload)),
};

/** Human-readable message from whatever a failed command threw. */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

let mockAudio: string | null = null;

/** Two minutes of soft noise bursts as a WAV blob, so players work in browser development. */
function mockAudioUrl(): string {
  if (mockAudio) return mockAudio;
  const rate = 8000;
  const n = rate * 120;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const text = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  text(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const burst = Math.floor(i / (rate * 0.4)) % 3 !== 2;
    const tone = Math.sin((2 * Math.PI * (180 + 40 * Math.sin(i / 3000)) * i) / rate);
    v.setInt16(44 + i * 2, burst ? tone * 2500 : 0, true);
  }
  mockAudio = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  return mockAudio;
}
