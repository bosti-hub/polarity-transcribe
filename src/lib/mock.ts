// In-memory stand-in for the Rust backend, used only when the UI runs in a plain browser
// (`npm run dev` without Tauri) so screens can be developed and reviewed quickly.

import type { AppInfo, Item, JobProgress, ModelInfo, Paragraph, Participant, Project, ProjectExtras, Settings, Source, Study, Transcript } from "./types";

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

export function mockListen(event: string, cb: Listener): () => void {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(cb);
  return () => listeners.get(event)?.delete(cb);
}

function emit(event: string, payload: unknown) {
  listeners.get(event)?.forEach((cb) => cb(payload));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let settings: Settings = {
  uiLanguage: "nl",
  theme: "system",
  model: "large-v3-turbo-q8",
  fastMode: false,
  threads: 0,
  useGpu: true,
  showDoubts: true,
  doubtThreshold: 0.5,
  onboarded: new URLSearchParams(location.search).get("welcome") === null,
  checkUpdates: true,
  rewindSeconds: 1.5,
  keyPlayPause: "",
  keyBack: "",
  keyForward: "",
  spellcheck: false,
};

const models: ModelInfo[] = [
  { id: "large-v3-turbo-q8", tier: "standard", sizeBytes: 874_188_075, installed: true, partialBytes: 0, recommended: true, extrasMissing: false },
  { id: "small-q5", tier: "light", sizeBytes: 190_085_487, installed: false, partialBytes: 0, recommended: false, extrasMissing: false },
  { id: "large-v3-q5", tier: "max", sizeBytes: 1_081_140_203, installed: false, partialBytes: 420_000_000, recommended: false, extrasMissing: false },
];

function source(name: string, duration: number, kind: Source["stereo"]["kind"] = "mono"): Source {
  return {
    fileName: name,
    originalPath: `C:\\Users\\student\\Opnames\\${name}`,
    duration,
    channels: kind === "mono" ? 1 : 2,
    stereo: {
      kind,
      confidence: 0.9,
      correlation: kind === "split_speakers" ? 0.2 : 0.97,
      levelDiffDb: 0.4,
      leftDominant: 0.4,
      rightDominant: 0.38,
      clippedLeft: 0,
      clippedRight: 0,
      monoChannel: "mix",
    },
    trimStart: 0,
    trimEnd: duration,
    modifiedMs: Date.now() - 12 * 86_400_000,
  };
}

function project(id: string, name: string, status: Project["status"], sources: (Source | null)[], daysAgo: number): Project {
  const t = Date.now() - daysAgo * 86_400_000;
  const both = sources.filter(Boolean).length === 2;
  return {
    id,
    name,
    createdAt: t,
    updatedAt: t,
    language: "nl",
    sources,
    splitStereo: null,
    speakerCount: 2,
    pauseThreshold: 3,
    glossary: [],
    model: null,
    status,
    duration: status === "ready" ? 3421 : 0,
    error: status === "failed" ? "FFmpeg failed: invalid data found when processing input" : null,
    dir: `C:\\mock\\${id}`,
    layout: both ? "dual_file" : sources[0]?.stereo.kind === "split_speakers" ? "split_stereo" : "single",
    studyId: null,
    participantIds: [],
    interviewDate: null,
    interviewer: "",
    tags: [],
    notes: "",
    review: "todo",
  };
}

function participant(code: string, attributes: Record<string, string> = {}): Participant {
  return { id: `pp-${code}`, code, attributes, notes: "" };
}

const studies: Study[] = [
  {
    id: "s-werkdruk",
    name: "Werkdruk in de zorg",
    createdAt: Date.now() - 30 * 86_400_000,
    updatedAt: Date.now() - 86_400_000,
    language: "nl",
    glossary: ["casemanager", "Zuyderland"],
    pauseThreshold: 3,
    interviewer: "Sanne",
    interviewerLabel: "Interviewer",
    participantPrefix: "R",
    attributes: ["Functie", "Leeftijd", "Locatie"],
    tags: ["Pilot", "Teamleider", "Avonddienst"],
    pseudonyms: [{ find: "Zuyderland", replace: "[ziekenhuis]" }],
    participants: [
      participant("R01", { Functie: "Verpleegkundige", Leeftijd: "30-39", Locatie: "Heerlen" }),
      participant("R02", { Functie: "Teamleider", Leeftijd: "40-49", Locatie: "Sittard" }),
      participant("R03", { Functie: "Verpleegkundige", Leeftijd: "20-29", Locatie: "Heerlen" }),
      participant("R04"),
    ],
    notes: "",
  },
  {
    id: "s-scriptie",
    name: "Scriptie onboarding",
    createdAt: Date.now() - 60 * 86_400_000,
    updatedAt: Date.now() - 20 * 86_400_000,
    language: "nl",
    glossary: [],
    pauseThreshold: 3,
    interviewer: "",
    interviewerLabel: "I",
    participantPrefix: "P",
    attributes: [],
    tags: [],
    participants: [],
    notes: "",
    pseudonyms: [],
  },
];

function inStudy(p: Project, studyId: string, code: string, extra: Partial<Project> = {}): Project {
  const study = studies.find((s) => s.id === studyId)!;
  const pp = study.participants.find((x) => x.code === code);
  return Object.assign(p, { studyId, participantIds: pp ? [pp.id] : [], interviewer: study.interviewer }, extra);
}

const projects: Project[] = [
  inStudy(project("p-ready", "Interview Alex — sessie 2", "ready", [source("mic1.wav", 3600), source("mic2.wav", 3612)], 0.1), "s-werkdruk", "R01", {
    review: "checked",
    tags: ["Avonddienst"],
    interviewDate: "2026-11-03",
  }),
  inStudy(project("p-setup", "Pilotinterview docent", "setup", [source("Voice 012.m4a", 8504), source("iPhone Sanne.m4a", 8506)], 1), "s-werkdruk", "R02", {
    tags: ["Pilot", "Teamleider"],
  }),
  inStudy(project("p-done", "Interview R03", "ready", [source("R03.m4a", 2950), null], 4), "s-werkdruk", "R03", { review: "done" }),
  project("p-stereo", "Focusgroep R3", "setup", [source("ZOOM0007.WAV", 1830, "split_speakers"), null], 2),
  inStudy(project("p-busy", "Interview respondent 7", "processing", [source("resp7.mp3", 2710), null], 3), "s-werkdruk", "R04"),
  project("p-failed", "Testopname", "failed", [source("test.ogg", 60), null], 9),
];
let queue: string[] = [];

function findStudy(id: string): Study {
  const s = studies.find((s) => s.id === id);
  if (!s) throw new Error(`study ${id} not found`);
  return s;
}

function nextCode(s: Study): string {
  const n = Math.max(0, ...s.participants.map((p) => Number(p.code.slice(s.participantPrefix.length)) || 0)) + 1;
  return `${s.participantPrefix}${String(n).padStart(2, "0")}`;
}

const SAMPLE: [string, string][] = [
  ["S1", "[eh], welkom Alex. [eh], dank je wel. Vorige keer hebben we een beetje stilgestaan bij wat er zoal speelde in jouw leven en met name op je werksituatie. [b:S2:ja klopt] En vandaag is het idee dat we wat verder gaan inzoomen op, [eh], specifieke problematiek en beter begrijpen hoe dat samenhangt."],
  ["S2", "Ja, ja."],
  ["S1", "Klinkt dat goed voor jou?"],
  ["S2", "Prima."],
  ["S1", "Alright. [uhm], heb jij nog je dagboekje bijgehouden zoals we vorige keer besproken hadden?"],
  ["S2", "[p:4.2] Ja, heb ik inderdaad wel geprobeerd. Ja, ik heb wel wat dingen opgeschreven. [n:[lacht]]"],
  ["S1", "Oké. En heb je daar een specifiek voorbeeld uit wat je bij is gebleven?"],
  ["S2", "Ja, ik kijk even. Oh ja, er is wel iets wat, wat wel gebeurd is, wat gewoon heel tieferend is voor, [uhm], voor mijn werk en zeg maar hoe dat dan gaat. [b:S1:hm-hm] Dus dat heb ik wel opgeschreven. Ik werk, zeg maar, met heel veel verschillende disciplines samen en over het algemeen gaat het wel goed, hoor. Alleen het probleem komt dus naar voren als de taakverdeling niet duidelijk is."],
  ["S1", "Kun je wat meer vertellen over dat specifieke voorbeeld?"],
  ["S2", "Nou, [ehm], ik heb een cliënt, [eh], zonder er te veel in detail te gaan, dat is een man die woont al dertig jaar in Nederland. [p:3.4] En die is zijn pas kwijt."],
];

function buildTranscript(): Transcript {
  let t = 0;
  const paragraphs: Paragraph[] = [];
  const DOUBT = new Set(["tieferend", "besproken", "samenhangt.", "cliënt,"]);
  for (let r = 0; r < 6; r++) {
    for (const [speaker, text] of SAMPLE) {
      const items: Item[] = [];
      for (const tok of text.match(/\[(?:b|p|n):[^\]]*\]\]?|\S+/g) ?? []) {
        if (tok.startsWith("[p:")) {
          const d = Number(tok.slice(3, -1));
          items.push({ k: "p", s: t, e: t + d });
          t += d;
        } else if (tok.startsWith("[b:")) {
          const [, sp, txt] = tok.slice(1, -1).split(":");
          items.push({ k: "b", sp, t: txt, s: t - 0.4, e: t });
        } else if (tok.startsWith("[n:")) {
          items.push({ k: "n", t: tok.slice(3, -1), s: t });
        } else {
          const d = 0.12 + tok.length * 0.045;
          const filler = /^\[(uhm|eh|ehm|hmm)\]/.test(tok);
          items.push({ k: "w", t: tok, s: round(t), e: round(t + d), c: DOUBT.has(tok) ? 0.31 : 0.93, ...(filler ? { f: true } : {}) });
          t += d + 0.05;
        }
      }
      const times = items.filter((i) => i.k !== "n") as { s: number; e: number }[];
      paragraphs.push({ id: `p${paragraphs.length + 1}`, speaker, start: times[0].s, end: times[times.length - 1].e, items });
      t += 0.4;
    }
  }
  return {
    version: 1,
    language: "nl",
    duration: round(t),
    speakers: [
      { id: "S1", name: "Spreker 1" },
      { id: "S2", name: "Spreker 2" },
    ],
    paragraphs,
  };
}

const round = (v: number) => Math.round(v * 1000) / 1000;

let transcript = buildTranscript();
let extras: ProjectExtras = { anonymize: [{ find: "Alex", replace: "[Respondent 1]" }], customTags: [] };
const jobs = new Map<string, JobProgress>();

function peaks(seed: number, seconds: number): ArrayBuffer {
  const n = Math.floor(seconds * 50);
  const out = new Uint8Array(n);
  let x = seed * 9301 + 49297;
  let level = 0.2;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const r = x / 0x7fffffff;
    if (i % 90 === 0) level = r > 0.25 ? 0.25 + r * 0.6 : 0.03;
    out[i] = Math.min(255, Math.round(Math.sqrt(level * (0.4 + 0.6 * r)) * 255));
  }
  return out.buffer;
}

function find(id: string): Project {
  const p = projects.find((p) => p.id === id);
  if (!p) throw new Error(`project ${id} not found`);
  return p;
}

async function runJob(id: string) {
  const stages: JobProgress["stage"][] = ["prepare", "sync", "voice", "speakers", "transcribe", "finish"];
  const texts = SAMPLE.map((s) => s[1].replace(/\[(?:b|p|n):[^\]]*\]\]?/g, ""));
  for (let i = 0; i <= 100; i++) {
    const cur = jobs.get(id);
    if (cur?.state === "cancelled") return;
    const stage = i < 3 ? stages[Math.min(3, i)] : i < 98 ? "transcribe" : "finish";
    const p: JobProgress = {
      projectId: id,
      stage,
      stageFraction: i / 100,
      fraction: i / 100,
      etaSeconds: i > 6 ? (100 - i) * 14 : null,
      preview: i > 4 ? texts[i % texts.length] : null,
      state: i === 100 ? "done" : "running",
    };
    jobs.set(id, p);
    emit("job-progress", p);
    await sleep(350);
  }
  find(id).status = "ready";
  const next = queue.shift();
  emit("queue-changed", [...queue]);
  if (next) {
    find(next).status = "processing";
    void runJob(next);
  }
}

export async function mockInvoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  await sleep(40);
  const id = args.id as string;
  switch (cmd) {
    case "app_info":
      return {
        version: "0.1.0",
        dataDir: "C:\\Users\\student\\AppData\\Local\\nl.polarity.transcribe",
        os: "windows",
        cpuThreads: 8,
        cpuName: "Intel Core i5-1135G7",
        ramGb: 16,
        cpuSupported: true,
        gpuBuild: false,
        gpu: null,
        gpuIntegrated: false,
        gpuSlower: null,
      } satisfies AppInfo;
    case "get_settings":
      return settings;
    case "set_settings":
      settings = args.settings as Settings;
      return;
    case "list_projects":
      return [...projects].sort((a, b) => b.updatedAt - a.updatedAt);
    case "create_project": {
      const p = project(`p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, args.name as string, "setup", [null, null], 0);
      p.language = args.language as Project["language"];
      const studyId = args.studyId as string | null;
      if (studyId) {
        const s = findStudy(studyId);
        const pp = participant(nextCode(s));
        pp.id = `pp-${Date.now()}-${Math.random()}`;
        s.participants.push(pp);
        Object.assign(p, { studyId, participantIds: [pp.id], language: s.language, pauseThreshold: s.pauseThreshold, interviewer: s.interviewer });
      }
      projects.push(p);
      return p;
    }
    case "list_studies":
      return [...studies].sort((a, b) => a.name.localeCompare(b.name));
    case "create_study": {
      const s: Study = { ...studies[1], id: `s-${Date.now()}`, name: args.name as string, language: args.language as Study["language"], participants: [], attributes: [], tags: [], glossary: [], interviewer: "", interviewerLabel: "Interviewer", participantPrefix: "R", createdAt: Date.now(), updatedAt: Date.now() };
      studies.push(s);
      return s;
    }
    case "update_study": {
      const s = findStudy(id);
      Object.assign(s, args.patch as object, { updatedAt: Date.now() });
      return s;
    }
    case "delete_study": {
      for (const p of projects.filter((p) => p.studyId === id)) {
        if (args.deleteInterviews) projects.splice(projects.indexOf(p), 1);
        else Object.assign(p, { studyId: null, participantIds: [] });
      }
      studies.splice(studies.indexOf(findStudy(id)), 1);
      return;
    }
    case "save_participant": {
      const s = findStudy(args.studyId as string);
      const pp = { ...(args.participant as Participant) };
      if (!pp.id) {
        pp.id = `pp-${Date.now()}`;
        if (!pp.code) pp.code = nextCode(s);
        s.participants.push(pp);
      } else {
        s.participants = s.participants.map((x) => (x.id === pp.id ? pp : x));
      }
      return s;
    }
    case "delete_participant": {
      const s = findStudy(args.studyId as string);
      s.participants = s.participants.filter((x) => x.id !== args.participantId);
      for (const p of projects) p.participantIds = p.participantIds.filter((x) => x !== args.participantId);
      return s;
    }
    case "queue_jobs": {
      for (const pid of args.ids as string[]) {
        const running = [...jobs.values()].some((j) => j.state === "running");
        if (!running) {
          find(pid).status = "processing";
          void runJob(pid);
        } else if (!queue.includes(pid)) queue.push(pid);
      }
      emit("queue-changed", [...queue]);
      return;
    }
    case "job_queue":
      return [...queue];
    case "get_project":
      return find(id);
    case "update_project": {
      const p = find(id);
      const patch = args.patch as Record<string, unknown>;
      for (const [k, v] of Object.entries(patch)) {
        if (k === "trims") {
          for (const t of v as { slot: number; start: number; end: number }[]) {
            const s = p.sources[t.slot];
            if (s) Object.assign(s, { trimStart: t.start, trimEnd: t.end });
          }
        } else if (k === "stereoMode") {
          p.splitStereo = v === "auto" ? null : v === "split";
          const s = p.sources[0];
          if (s && !p.sources[1]) p.layout = (p.splitStereo ?? s.stereo.kind === "split_speakers") && s.channels === 2 ? "split_stereo" : "single";
        } else {
          (p as unknown as Record<string, unknown>)[k] = v;
        }
      }
      p.updatedAt = Date.now();
      // A copy, as the real backend returns: React only re-renders for a new object.
      return { ...p };
    }
    case "delete_project":
      projects.splice(projects.indexOf(find(id)), 1);
      return;
    case "import_audio": {
      const slot = args.slot as number;
      for (let i = 1; i <= 20; i++) {
        await sleep(60);
        emit("import-progress", { projectId: id, slot, fraction: i / 20 });
      }
      const p = find(id);
      const name = String(args.path).split(/[\\/]/).pop() ?? "audio";
      p.sources[slot] = source(name, 1800 + slot * 7, /stereo|zoom/i.test(name) ? "split_speakers" : "mono");
      p.layout = p.sources[0] && p.sources[1] ? "dual_file" : p.sources.find(Boolean)?.stereo.kind === "split_speakers" ? "split_stereo" : "single";
      return p;
    }
    case "cancel_import":
      return;
    case "remove_audio": {
      const p = find(id);
      p.sources[args.slot as number] = null;
      p.layout = "single";
      return p;
    }
    case "read_peaks": {
      const s = find(id).sources[args.slot as number];
      return peaks((args.slot as number) * 2 + (args.right ? 1 : 0) + 3, s?.duration ?? 60);
    }
    case "quick_sync":
      await sleep(600);
      return 1.105;
    case "list_models":
      return models;
    case "download_model": {
      const m = models.find((m) => m.id === id)!;
      void (async () => {
        for (let got = m.partialBytes; got < m.sizeBytes; got += m.sizeBytes / 40) {
          emit("download-progress", { id, receivedBytes: got, totalBytes: m.sizeBytes, speed: 11_500_000, state: "downloading" });
          await sleep(120);
        }
        m.installed = true;
        m.partialBytes = 0;
        emit("download-progress", { id, receivedBytes: m.sizeBytes, totalBytes: m.sizeBytes, speed: 0, state: "done" });
      })();
      return;
    }
    case "cancel_download":
    case "import_model":
      return;
    case "delete_model":
      models.find((m) => m.id === id)!.installed = false;
      return;
    case "start_job":
      return mockInvoke("queue_jobs", { ids: [id] });
    case "cancel_job": {
      if (queue.includes(id)) {
        queue = queue.filter((q) => q !== id);
        emit("queue-changed", [...queue]);
        return;
      }
      const cur = jobs.get(id);
      if (cur) {
        const p = { ...cur, state: "cancelled" as const };
        jobs.set(id, p);
        emit("job-progress", p);
      }
      return;
    }
    case "job_status":
      return jobs.get(id) ?? null;
    case "load_transcript":
      return transcript;
    case "save_transcript":
      transcript = args.transcript as Transcript;
      return;
    case "load_extras":
      return extras;
    case "save_extras":
      extras = args.extras as ProjectExtras;
      return;
    case "load_report":
      return {
        method: "delay",
        sync: { offset: 1.105, driftPpm: 0, windowsUsed: 30, windowsTotal: 30, jumps: 0, residualMs: 0.02 },
        bleed: { separationDb: 1.0, separable: false },
        delay: { delaysMs: [-0.625, 0.016], separationMs: 0.64, separable: true },
        // One passage with suspiciously few words, so the notice can be seen in the browser.
        sparse: [{ start: 96.2, end: 111.9 }],
      };
    case "copy_original":
      await sleep(300);
      return true;
    case "system_info":
      return "Polarity Transcribe 0.1.0 (mock)\nSystem: browser preview\nGraphics devices: none";
    case "export_recording":
      await sleep(300);
      return;
    case "write_file":
    case "reveal_in_folder":
      return;
    default:
      throw new Error(`mock backend: unknown command ${cmd}`);
  }
}
