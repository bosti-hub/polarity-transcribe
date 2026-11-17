// Shared data shapes. These mirror the Rust structs in crates/core and src-tauri.

export type Language = "nl" | "en";

export type StereoKind = "mono" | "safety_track" | "room_stereo" | "split_speakers";
export type Channel = "mix" | "left" | "right";

export interface StereoVerdict {
  kind: StereoKind;
  confidence: number;
  correlation: number;
  levelDiffDb: number;
  leftDominant: number;
  rightDominant: number;
  clippedLeft: number;
  clippedRight: number;
  monoChannel: Channel;
}

export interface Source {
  fileName: string;
  originalPath: string;
  duration: number;
  /** 1, or 2 when left and right differ. */
  channels: number;
  stereo: StereoVerdict;
  trimStart: number;
  trimEnd: number;
  /** Last-modified time of the original file (ms): usually when it was recorded. */
  modifiedMs?: number | null;
}

export type ProjectStatus = "setup" | "processing" | "ready" | "failed";
export type Layout = "single" | "split_stereo" | "dual_file";

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  language: Language;
  sources: (Source | null)[];
  splitStereo: boolean | null;
  speakerCount: number;
  pauseThreshold: number;
  glossary: string[];
  model: string | null;
  status: ProjectStatus;
  duration: number;
  error: string | null;
  /** Absolute path of the project folder. */
  dir: string;
  layout: Layout;

  // ---- interview details
  studyId: string | null;
  /** Participants (ids within the study) who are interviewed. */
  participantIds: string[];
  /** YYYY-MM-DD; null = the recording's file date. */
  interviewDate: string | null;
  interviewer: string;
  tags: string[];
  /** Field notes, memo. */
  notes: string;
  review: Review;
}

/** Manual progress after transcription. */
export type Review = "todo" | "checked" | "anonymised" | "done";

export interface ProjectPatch {
  name?: string;
  language?: Language;
  stereoMode?: "auto" | "split" | "mono";
  speakerCount?: number;
  pauseThreshold?: number;
  glossary?: string[];
  model?: string;
  trims?: { slot: number; start: number; end: number }[];
  /** Move to another study; "" takes the interview out of its study. */
  studyId?: string;
  participantIds?: string[];
  /** "YYYY-MM-DD", or "" for the recording's file date. */
  interviewDate?: string;
  interviewer?: string;
  tags?: string[];
  notes?: string;
  review?: Review;
}

// ---------------------------------------------------------------- studies

export interface Participant {
  id: string;
  /** Pseudonymous code used in transcripts and exports ("R03"). */
  code: string;
  /** Attribute values by attribute name. */
  attributes: Record<string, string>;
  notes: string;
}

export interface Study {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  language: Language;
  glossary: string[];
  pauseThreshold: number;
  /** Default interviewer for new interviews. */
  interviewer: string;
  /** Speaker label of the interviewer in transcripts. */
  interviewerLabel: string;
  /** Prefix of participant codes ("R" gives R01, R02, ...). */
  participantPrefix: string;
  /** Names of the participant attributes (columns). */
  attributes: string[];
  tags: string[];
  participants: Participant[];
  notes: string;
  /** Replacements applied to every interview of the study when exporting. */
  pseudonyms: AnonymizeRule[];
}

export interface StudyPatch {
  name?: string;
  language?: Language;
  glossary?: string[];
  pauseThreshold?: number;
  interviewer?: string;
  interviewerLabel?: string;
  participantPrefix?: string;
  attributes?: string[];
  tags?: string[];
  notes?: string;
  pseudonyms?: AnonymizeRule[];
}

export interface AppInfo {
  version: string;
  dataDir: string;
  os: string;
  cpuThreads: number;
  cpuName: string;
  ramGb: number;
  /** False on CPUs too old to run the recogniser (no AVX2). */
  cpuSupported: boolean;
  gpuBuild: boolean;
  /** The graphics card transcription would use, or null for the processor. */
  gpu: string | null;
  /** Whether that device is built into the processor. */
  gpuIntegrated: boolean;
  /** Integrated graphics not used because they are not faster than the processor. */
  gpuSlower: string | null;
}

// ---------------------------------------------------------------- models

export interface ModelInfo {
  id: string;
  /** Translation key suffix: "standard" | "light" | "max". */
  tier: "standard" | "light" | "max";
  sizeBytes: number;
  installed: boolean;
  /** Bytes already on disk for a partial download. */
  partialBytes: number;
  recommended: boolean;
  /** The small voice model that comes with every speech model still has to be fetched. */
  extrasMissing: boolean;
}

export interface DownloadProgress {
  id: string;
  receivedBytes: number;
  totalBytes: number;
  /** Bytes per second, smoothed. */
  speed: number;
  state: "downloading" | "verifying" | "done" | "error" | "paused";
  error?: string;
}

// ---------------------------------------------------------------- jobs

export type JobStage =
  | "prepare"
  | "sync"
  | "voice"
  | "speakers"
  | "transcribe"
  | "diarize"
  | "finish";

export interface JobProgress {
  projectId: string;
  stage: JobStage;
  /** 0..1 within the stage. */
  stageFraction: number;
  /** 0..1 overall. */
  fraction: number;
  /** Estimated seconds remaining, if known. */
  etaSeconds: number | null;
  /** Most recently recognised text, for the live preview. */
  preview: string | null;
  state: "running" | "paused" | "done" | "error" | "cancelled";
  error?: string;
}

// ---------------------------------------------------------------- transcript

export interface Speaker {
  /** Stable id, e.g. "S1". */
  id: string;
  name: string;
}

/** A recognised or typed word. `t` includes attached punctuation; fillers are stored bracketed. */
export interface WordItem {
  k: "w";
  t: string;
  /** Start / end in seconds on the project timeline. */
  s: number;
  e: number;
  /** Recogniser confidence 0..1 (1 for anything a person typed or confirmed). */
  c: number;
  /** Hesitation filler such as "[uhm]". */
  f?: boolean;
}

/** A measured silence, rendered as "[stilte 3.5s]" / "[silence 3.5s]". */
export interface PauseItem {
  k: "p";
  s: number;
  e: number;
}

/** A short listening sound by another speaker, rendered inline as "[Name: hm-hm]". */
export interface BackchannelItem {
  k: "b";
  sp: string;
  t: string;
  s: number;
  e: number;
}

/** A behavioural note such as "[lacht]". `t` includes the brackets. */
export interface NoteItem {
  k: "n";
  t: string;
  /** Time of the nearest word, if known. */
  s?: number;
}

export type Item = WordItem | PauseItem | BackchannelItem | NoteItem;

export interface Paragraph {
  id: string;
  speaker: string;
  start: number;
  end: number;
  items: Item[];
}

export interface Transcript {
  version: 1;
  language: Language;
  /** Length of the transcribed region in seconds. */
  duration: number;
  speakers: Speaker[];
  paragraphs: Paragraph[];
}

export interface AnonymizeRule {
  find: string;
  replace: string;
}

/** Per-project editor state that is not part of the transcript text. */
export interface ProjectExtras {
  anonymize: AnonymizeRule[];
  customTags: string[];
  /** Built-in labels removed from this interview's list. */
  hiddenTags?: string[];
  /** Transcript time (seconds) up to which the text has been checked against the audio. */
  reviewedUntil?: number | null;
  /** Passages saved as quotes. */
  quotes?: Quote[];
}

/** A saved passage: its text when saved, where it is in the audio, and a note. */
export interface Quote {
  id: string;
  text: string;
  /** Start and end in transcript time (seconds). */
  s: number;
  e: number;
  /** Speaker id of the turn the quote starts in. */
  speaker: string;
  note: string;
  createdAt: number;
}

// ---------------------------------------------------------------- settings

export interface Settings {
  uiLanguage: Language;
  theme: "system" | "light" | "dark";
  /** Model id used for new transcriptions. */
  model: string | null;
  /** Trade a little accuracy for ~30% more speed. */
  fastMode: boolean;
  /** 0 = automatic. */
  threads: number;
  useGpu: boolean;
  showDoubts: boolean;
  /** Words below this confidence are marked as uncertain. */
  doubtThreshold: number;
  onboarded: boolean;
  /** Look for a newer version on GitHub at startup. */
  checkUpdates: boolean;
  /** Seconds playback jumps back when resuming after a pause (0 = off). */
  rewindSeconds: number;
  /** Extra keys (for example a foot pedal); "" = none. Format: "Ctrl+Alt+Shift+Code". */
  keyPlayPause: string;
  keyBack: string;
  keyForward: string;
  /** Underline spelling mistakes in the editor. */
  spellcheck: boolean;
}
