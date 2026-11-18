import { describe, expect, it } from "vitest";
// fflate is the zip library docx itself depends on; used here only to inspect the output.
import { strFromU8, unzipSync } from "fflate";
import type { Item, Transcript } from "../lib/types";
import { exportTranscript, type ExportOptions } from "./index";
import { sanitizeFileName } from "./common";

const NUMBERS = [
  "een", "twee", "drie", "vier", "vijf", "zes", "zeven",
  "acht", "negen", "tien", "elf", "twaalf", "dertien", "veertien",
];

/** Two speakers, every item kind; the second turn is long enough to need two cues. */
const nl: Transcript = {
  version: 1,
  language: "nl",
  duration: 3723,
  speakers: [
    { id: "S1", name: "Anna" },
    { id: "S2", name: "Bram" },
  ],
  paragraphs: [
    {
      id: "p1",
      speaker: "S1",
      start: 3.2,
      end: 8.9,
      items: [
        { k: "w", t: "Dus", s: 3.2, e: 3.5, c: 0.9 },
        { k: "w", t: "[uhm],", s: 3.6, e: 4.0, c: 1, f: true },
        { k: "w", t: "ik", s: 4.1, e: 4.3, c: 0.8 },
        { k: "n", t: "[lacht]", s: 4.3 },
        { k: "p", s: 4.4, e: 7.9 },
        { k: "w", t: "ja.", s: 8.0, e: 8.4, c: 1 },
        { k: "b", sp: "S2", t: "hm-hm", s: 8.5, e: 8.9 },
      ],
    },
    {
      id: "p2",
      speaker: "S2",
      start: 75,
      end: 81.9,
      items: [
        ...NUMBERS.map((t, i): Item => ({ k: "w", t, s: 75 + i * 0.5, e: 75 + i * 0.5 + 0.4, c: 1 })),
        { k: "n", t: "[zucht]" },
      ],
    },
  ],
};

const P1_NL = "Dus [uhm], ik [lacht] [stilte 3.5s] ja. [Bram: hm-hm]";
const P2_TEXT = `${NUMBERS.join(" ")} [zucht]`;

const en: Transcript = {
  version: 1,
  language: "en",
  duration: 42,
  speakers: [
    { id: "S1", name: "Interviewer" },
    { id: "S2", name: "Sam" },
  ],
  paragraphs: [
    {
      id: "a",
      speaker: "S1",
      start: 0,
      end: 8,
      items: [
        { k: "w", t: "One", s: 0, e: 2, c: 1 },
        { k: "w", t: "two", s: 2, e: 4, c: 1 },
        { k: "w", t: "three", s: 4, e: 6, c: 1 },
        { k: "w", t: "four.", s: 6, e: 8, c: 1 },
      ],
    },
    {
      // Overlapping speech: starts before the previous turn ends.
      id: "b",
      speaker: "S2",
      start: 7,
      end: 9,
      items: [
        { k: "n", t: "[laughs]" },
        { k: "w", t: "Right", s: 7, e: 7.5, c: 1 },
        { k: "p", s: 7.5, e: 9.5 },
        { k: "w", t: "_so_", s: 9.5, e: 9.8, c: 1 },
      ],
    },
    { id: "c", speaker: "S1", start: 12, end: 13, items: [{ k: "n", t: "[inaudible]" }] },
  ],
};

const base: ExportOptions = {
  format: "txt",
  projectName: "Interview 3: Anna/Bram?",
  date: new Date(2026, 2, 5),
  timestamps: true,
  numbering: "none",
  uiLanguage: "nl",
};

async function text(transcript: Transcript, options: Partial<ExportOptions>): Promise<string> {
  const result = await exportTranscript(transcript, { ...base, ...options });
  return new TextDecoder().decode(result.bytes);
}

describe("txt", () => {
  it("renders a Dutch header and timestamped turns", async () => {
    expect(await text(nl, { format: "txt" })).toBe(
      [
        "Interview 3: Anna/Bram?",
        "Datum: 5 maart 2026",
        "Duur: 1 h 2 min",
        "Sprekers: Anna, Bram",
        "Taal: Nederlands",
        "",
        `Anna [0:03]: ${P1_NL}`,
        "",
        `Bram [1:15]: ${P2_TEXT}`,
        "",
      ].join("\n"),
    );
  });

  it("numbers turns, falls back from line numbering and omits timestamps", async () => {
    for (const numbering of ["paragraph", "line"] as const) {
      const out = await text(nl, { numbering, timestamps: false });
      expect(out).toContain(`\n\n1. Anna: ${P1_NL}\n\n2. Bram: ${P2_TEXT}\n`);
    }
  });

  it("uses English labels and pause tags", async () => {
    const out = await text(en, { uiLanguage: "en" });
    expect(out.split("\n").slice(1, 5)).toEqual([
      "Date: 5 March 2026",
      "Duration: 42 s",
      "Speakers: Interviewer, Sam",
      "Language: English",
    ]);
    expect(out).toContain("Sam [0:07]: [laughs] Right [silence 2.0s] _so_");
  });

  it("names the language in the UI language", async () => {
    expect(await text(nl, { uiLanguage: "en" })).toContain("Language: Dutch");
    expect(await text(en, { uiLanguage: "nl" })).toContain("Taal: Engels");
  });
});

describe("md", () => {
  it("renders a title, metadata list and turns", async () => {
    expect(await text(nl, { format: "md", projectName: "Interview 3" })).toBe(
      [
        "# Interview 3",
        "",
        "- **Datum:** 5 maart 2026",
        "- **Duur:** 1 h 2 min",
        "- **Sprekers:** Anna, Bram",
        "- **Taal:** Nederlands",
        "",
        `**Anna** *(0:03)*: ${P1_NL}`,
        "",
        `**Bram** *(1:15)*: ${P2_TEXT}`,
        "",
      ].join("\n"),
    );
  });

  it("numbers turns and escapes emphasis characters", async () => {
    const out = await text(en, { format: "md", numbering: "paragraph", timestamps: false });
    expect(out).toContain("\n\n2. **Sam**: [laughs] Right [silence 2.0s] \\_so\\_\n");
  });
});

describe("json", () => {
  it("wraps the transcript unchanged", async () => {
    const out = await text(nl, { format: "json" });
    const parsed = JSON.parse(out);
    expect(parsed.generator).toBe("Polarity Transcribe");
    expect(parsed.project).toBe(base.projectName);
    expect(parsed.date).toBe("2026-03-05");
    expect(new Date(parsed.exportedAt).toISOString()).toBe(parsed.exportedAt);
    expect(parsed.transcript).toEqual(nl);
    expect(out).toContain('\n  "generator"');
  });
});

describe("srt", () => {
  const TIME = /^(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})$/;

  function cues(srt: string) {
    return srt
      .trimEnd()
      .split("\n\n")
      .map((block) => {
        const [index, time, ...lines] = block.split("\n");
        const m = TIME.exec(time);
        if (!m) throw new Error(`bad time line: ${time}`);
        const n = m.slice(1).map(Number);
        return {
          index: Number(index),
          start: n[0] * 3_600_000 + n[1] * 60_000 + n[2] * 1000 + n[3],
          end: n[4] * 3_600_000 + n[5] * 60_000 + n[6] * 1000 + n[7],
          text: lines.join("\n"),
        };
      });
  }

  it("splits at pauses and after 12 words, prefixing each turn with its speaker", async () => {
    expect(await text(nl, { format: "srt" })).toBe(
      [
        "1",
        "00:00:03,200 --> 00:00:04,300",
        "Anna: Dus [uhm], ik [lacht]",
        "",
        "2",
        "00:00:08,000 --> 00:00:08,900",
        "ja. [Bram: hm-hm]",
        "",
        "3",
        "00:01:15,000 --> 00:01:20,900",
        `Bram: ${NUMBERS.slice(0, 12).join(" ")}`,
        "",
        "4",
        "00:01:21,000 --> 00:01:21,900",
        "dertien veertien [zucht]",
        "",
      ].join("\n"),
    );
  });

  it("caps cue length at 6 s and keeps cues monotonic and non-overlapping", async () => {
    const list = cues(await text(en, { format: "srt" }));
    expect(list.map((c) => c.text)).toEqual([
      "Interviewer: One two three",
      "four.",
      "Sam: [laughs] Right",
      "_so_",
      "Interviewer: [inaudible]",
    ]);
    expect(list.map((c) => c.index)).toEqual([1, 2, 3, 4, 5]);
    list.forEach((c, i) => {
      expect(c.end).toBeGreaterThan(c.start);
      expect(c.end - c.start).toBeLessThanOrEqual(6000);
      if (i > 0) expect(c.start).toBeGreaterThanOrEqual(list[i - 1].end);
    });
    // The overlapping turn is pushed to start where the previous cue ends.
    expect(list[2].start).toBe(8000);
    expect(list[4]).toMatchObject({ start: 12000, end: 13000 });
  });
});

describe("docx", () => {
  it("produces a Word file with named styles and the transcript text", async () => {
    const result = await exportTranscript(nl, { ...base, format: "docx", numbering: "line" });
    expect(result.extension).toBe("docx");
    expect(result.fileName).toBe("Interview 3 Anna Bram.docx");
    expect(String.fromCharCode(result.bytes[0], result.bytes[1])).toBe("PK");

    const files = unzipSync(result.bytes);
    const xml = strFromU8(files["word/document.xml"]);
    const styles = strFromU8(files["word/styles.xml"]);
    expect(xml).toContain("Anna:");
    expect(xml).toContain("Bram:");
    expect(xml).toContain("[uhm],");
    expect(xml).toContain("[0:03]");
    expect(xml).toContain("Datum: ");
    expect(xml).toMatch(/<w:lnNumType[^>]*w:restart="continuous"/);
    // Only the turns are line-numbered: title and the four metadata lines opt out.
    expect(xml.match(/<w:suppressLineNumbers\/>/g)).toHaveLength(5);
    expect(xml).toMatch(/<w:pgSz[^>]*w:w="11906"/);
    for (const id of ["Transcript", "Speaker", "Timestamp", "Filler", "Annotation"]) {
      expect(styles).toContain(`w:styleId="${id}"`);
    }
    expect(xml).toMatch(/<w:rStyle w:val="Filler"\/><\/w:rPr><w:t xml:space="preserve">\[uhm\], <\/w:t>/);
  });

  it("numbers turns with a hanging indent and no line numbering", async () => {
    const result = await exportTranscript(en, { ...base, format: "docx", numbering: "paragraph", timestamps: false });
    const xml = strFromU8(unzipSync(result.bytes)["word/document.xml"]);
    expect(xml).not.toContain("lnNumType");
    expect(xml).not.toContain("[0:00]");
    expect(xml).toMatch(/<w:rStyle w:val="TurnNumber"\/><\/w:rPr><w:t[^>]*>3<\/w:t>/);
    expect(xml).toContain('w:hanging="567"');
  });
});

describe("file names", () => {
  it("strips illegal characters, trailing dots and reserved names", () => {
    expect(sanitizeFileName('a<b>c:"d|e?*f. ', "txt")).toBe("a b c d e f.txt");
    expect(sanitizeFileName("CON", "md")).toBe("_CON.md");
    expect(sanitizeFileName("  ", "srt")).toBe("transcript.srt");
  });
});

describe("clean reading version", () => {
  it("drops fillers, pauses and listening sounds and repairs capitals and punctuation", async () => {
    const t: Transcript = {
      ...nl,
      paragraphs: [
        {
          id: "c1",
          speaker: "S1",
          start: 0,
          end: 5,
          items: [
            { k: "w", t: "[eh],", s: 0, e: 0.3, c: 1, f: true },
            { k: "w", t: "welkom", s: 0.4, e: 0.8, c: 1 },
            { k: "w", t: "allemaal,", s: 0.9, e: 1.2, c: 1 },
            { k: "w", t: "[uhm].", s: 1.3, e: 1.6, c: 1, f: true },
            { k: "w", t: "[eh]", s: 1.7, e: 1.9, c: 1, f: true },
            { k: "w", t: "fijn.", s: 2.0, e: 2.3, c: 1 },
            { k: "b", sp: "S2", t: "ja", s: 2.4, e: 2.6 },
            { k: "p", s: 2.6, e: 5 },
            { k: "n", t: "[lacht]" },
          ],
        },
        { id: "c2", speaker: "S2", start: 6, end: 7, items: [{ k: "w", t: "[hm].", s: 6, e: 7, c: 1, f: true }] },
      ],
    };
    const out = await text(t, { clean: true, timestamps: false });
    expect(out).toContain("Anna: Welkom allemaal. Fijn. [lacht]\n");
    // A turn of only fillers disappears.
    expect(out).not.toContain("Bram:");
  });
});

describe("qda formats", () => {
  it("puts an f4 timestamp at the end of each turn for MAXQDA and ATLAS.ti", async () => {
    const { f4Stamp } = await import("./qda");
    expect(f4Stamp(83.47)).toBe("#00:01:23-5#");
    expect(f4Stamp(3723.04)).toBe("#01:02:03-0#");
    const result = await exportTranscript(nl, { ...base, format: "maxqda", offset: 450 });
    expect(result.extension).toBe("docx");
    const xml = strFromU8(unzipSync(result.bytes)["word/document.xml"]);
    // The first turn ends at 8.9 s; the trim starts at 7:30 in the original recording.
    expect(xml).toContain("#00:07:38-9#");
    expect(xml).toContain("#00:08:51-9#");
    expect(xml).not.toContain("Datum");
  });

  it("writes a single table with time span, speaker and content for NVivo", async () => {
    const result = await exportTranscript(nl, { ...base, format: "nvivo" });
    const xml = strFromU8(unzipSync(result.bytes)["word/document.xml"]);
    expect(xml.match(/<w:tbl>/g)).toHaveLength(1);
    expect(xml.match(/<w:tr>/g)?.length ?? xml.match(/<w:tr /g)?.length).toBe(3);
    for (const s of ["Tijdsduur", "Spreker", "Inhoud", "00:00:03 - 00:00:09", "Anna", "00:01:15 - 00:01:22"]) expect(xml).toContain(s);
  });
});

describe("vtt", () => {
  it("writes WebVTT with voice tags and escaped text", async () => {
    const out = await text(en, { format: "vtt" });
    expect(out.startsWith("WEBVTT\n\n00:00:00.000 --> ")).toBe(true);
    expect(out).toContain("<v Interviewer>One two three");
    expect(out).toContain("<v Sam>[laughs] Right");
  });
});

describe("qdpx", () => {
  it("builds a REFI-QDA project with sources, cases, variables, sets and codes", async () => {
    const { buildQdpx, transcriptText } = await import("./qdpx");
    const study: import("../lib/types").Study = {
      id: "s", name: "Werkdruk & zorg", createdAt: 0, updatedAt: 0, language: "nl" as const, glossary: [], pauseThreshold: 3,
      interviewer: "Sanne", interviewerLabel: "I", participantPrefix: "R", attributes: ["Functie", "Leeftijd"], tags: [],
      participants: [
        { id: "a", code: "R01", attributes: { Functie: "Verpleegkundige", Leeftijd: "" }, notes: "" },
        { id: "b", code: "R02", attributes: {}, notes: "" },
      ],
      notes: "Pilotfase",
      pseudonyms: [],
      keepTerms: [],
    };
    const project = (id: string, name: string, participantIds: string[], tags: string[]) =>
      ({ id, name, participantIds, tags, notes: id === "x" ? "Rustige omgeving" : "", interviewer: "Sanne" }) as unknown as import("../lib/types").Project;
    const bytes = buildQdpx(
      study,
      [
        { project: project("x", "Interview <1>", ["a"], ["Pilot"]), transcript: nl, date: "2026-03-05" },
        { project: project("y", "Interview 2", ["b"], ["Pilot", "Avond"]), transcript: en, date: "2026-03-06" },
      ],
      { uiLanguage: "nl", projectName: study.name, version: "0.1.0" },
    );
    const files = unzipSync(bytes);
    const xml = strFromU8(files["project.qde"]);
    const sources = Object.keys(files).filter((f) => f.startsWith("sources/"));
    expect(sources).toHaveLength(2);
    expect(xml).toContain('xmlns="urn:QDA-XML:project:1.0"');
    expect(xml).toContain('name="Werkdruk &amp; zorg"');
    expect(xml).toContain('name="Interview &lt;1&gt;"');
    expect(xml.match(/<Case /g)).toHaveLength(2);
    expect(xml.match(/<Set /g)).toHaveLength(2);
    expect(xml).toContain("<TextValue>Verpleegkundige</TextValue>");
    expect(xml).not.toContain("<TextValue></TextValue>");
    expect(xml).toContain("<DateValue>2026-03-05</DateValue>");
    for (const code of ["lacht", "zucht", "laughs", "inaudible"]) expect(xml).toContain(`name="${code}" isCodable="true"`);

    // The coded spot really holds the annotation.
    const { text: plain, selections } = transcriptText(nl);
    const lacht = selections.find((s) => s.code === "lacht")!;
    expect(Array.from(plain).slice(lacht.start, lacht.end).join("")).toBe("[lacht]");
    expect(plain.startsWith("Anna: Dus [uhm], ik [lacht]")).toBe(true);

    // For schema validation outside the test run: QDPX_SAMPLE=<path> npx vitest run
    const sample = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.QDPX_SAMPLE;
    if (sample) {
      const fs = await import("node:fs");
      fs.writeFileSync(sample, bytes);
    }
  });
});

describe("pseudonymised export", () => {
  it("replaces names in the text, the speakers, the title and the file name", async () => {
    const rules = [{ find: "Anna", replace: "[R01]" }, { find: "Bram", replace: "[I]" }];
    const result = await exportTranscript(nl, { ...base, format: "txt", projectName: "Interview Anna", anonymize: rules });
    const out = new TextDecoder().decode(result.bytes);
    expect(result.fileName).toBe("Interview [R01].txt");
    expect(out.startsWith("Interview [R01]\n")).toBe(true);
    expect(out).toContain("Sprekers: [R01], [I]");
    expect(out).toContain("[R01] [0:03]: Dus [uhm], ik [lacht] [stilte 3.5s] ja. [[I]: hm-hm]");
    expect(out).not.toMatch(/Anna|Bram/);
  });
});

describe("pause notation", () => {
  it("writes pauses in the Dresing & Pehl and Jefferson conventions", async () => {
    const { pauseText } = await import("./notation");
    expect([0.9, 1.6, 2.6, 3.4, 4.6].map((s) => pauseText(s, "dresing"))).toEqual(["(.)", "(..)", "(...)", "(...)", "(5)"]);
    expect(pauseText(3.47, "jefferson")).toBe("(3.5)");
    expect(await text(nl, { notation: "dresing", timestamps: false })).toContain("Anna: Dus [uhm], ik [lacht] (4) ja.");
    expect(await text(nl, { notation: "jefferson", timestamps: false })).toContain("ik [lacht] (3.5) ja.");
    // Subtitles still break at the pause instead of writing it.
    expect(await text(nl, { format: "srt", notation: "dresing" })).not.toContain("(...)");
  });
});
