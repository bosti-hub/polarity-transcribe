// The in-app manual: short on purpose. One section per step of the workflow, a few lines each.
// Shortcuts are written as "Mod+Q" etc. and shown in the platform's notation.

import { isMac, MOD, shortcutLabel } from "./keys";
import type { Language } from "./types";

export interface HelpSection {
  title: string;
  points: string[];
}

/** "Mod" in a shortcut is ⌘ on a Mac and Ctrl elsewhere. */
const k = (shortcut: string) => shortcutLabel(shortcut.replace(/\bMod\b/g, MOD));
/** On a Mac keyboard F8 is the play key; the function key itself needs fn. */
const F8 = isMac ? "fn F8" : "F8";

export function helpSections(lang: Language): HelpSection[] {
  if (lang === "nl") {
    return [
      {
        title: "1. Opname toevoegen",
        points: [
          "Klik Nieuw interview en sleep je opname erin.",
          "Twee microfoons of telefoons? Voeg beide bestanden aan hetzelfde interview toe. De app legt ze zelf gelijk.",
          "Leg dan elke telefoon dicht bij één spreker: zo herkent de app het best wie er praat.",
        ],
      },
      {
        title: "2. Transcriberen",
        points: [
          "Kies de taal en het aantal sprekers en klik Transcriptie starten.",
          "Alles gebeurt op je eigen computer. Je kunt intussen doorwerken.",
          "Meerdere interviews? Alles transcriberen zet ze in de wachtrij.",
        ],
      },
      {
        title: "3. Corrigeren",
        points: [
          `Klik op een woord om vanaf daar te luisteren. Afspelen/pauzeren: Esc of ⏯ (met tekst geselecteerd ook de spatiebalk).`,
          `Gele woorden zijn onzeker. ${F8}: volgende, ${k("Mod+Enter")}: klopt.`,
          `${k("Alt+←")} / ${k("Alt+→")}: terug/vooruit. ${k("Alt+↓")} / ${k("Alt+↑")}: langzamer/sneller. ${k("Mod+L")}: selectie herhalen.`,
          `${k("Mod+1")}–9: notatie invoegen, zoals [lacht].`,
          "Enter splitst een beurt, Backspace aan het begin voegt samen. Klik op de sprekernaam om een beurt aan iemand anders te geven.",
          `Alles wordt automatisch opgeslagen. Vergissing? ${k("Mod+Z")}.`,
        ],
      },
      {
        title: "4. Pseudonimiseren",
        points: [
          "Paneel Pseudonimiseren: vul in wat vervangen moet worden en waardoor, bijvoorbeeld Jan → [collega 1].",
          "Regels van de studie gelden voor al haar interviews.",
          "Je ziet het pseudoniem meteen in de tekst; wijs het aan voor het origineel. Het origineel blijft bewaard en wordt pas bij het exporteren vervangen.",
          "De audio wordt niet gepseudonimiseerd.",
        ],
      },
      {
        title: "5. Citaten",
        points: [
          `Selecteer tekst en druk ${k("Mod+Q")}.`,
          "Exporteren via het paneel Citaten of via de studie: genummerd, met per citaat een audiofragment (desgewenst met onherkenbare stem en weggepiepte namen).",
        ],
      },
      {
        title: "6. Exporteren",
        points: [
          "Exporteren (rechtsboven): Word, tekst, MAXQDA, ATLAS.ti, NVivo, REFI-QDA (.qdpx) of ondertitels.",
          "Een hele studie in één keer: open de studie en kies Exporteren.",
        ],
      },
      {
        title: "Privacy",
        points: [
          "Opnames en transcripten verlaten je computer nooit.",
          "Internet wordt alleen gebruikt om spraakmodellen te downloaden en om op updates te controleren (uit te zetten in Instellingen).",
        ],
      },
    ];
  }
  return [
    {
      title: "1. Add a recording",
      points: [
        "Click New interview and drop your recording in.",
        "Two microphones or phones? Add both files to the same interview. The app lines them up itself.",
        "Put each phone close to one speaker: that is how the app best tells who is talking.",
      ],
    },
    {
      title: "2. Transcribe",
      points: [
        "Choose the language and number of speakers and click Start transcription.",
        "Everything runs on your own computer. You can keep working meanwhile.",
        "Several interviews? Transcribe all puts them in a queue.",
      ],
    },
    {
      title: "3. Correct",
      points: [
        "Click a word to listen from there. Play/pause: Esc or ⏯ (with text selected, also the space bar).",
        `Yellow words are uncertain. ${F8}: next, ${k("Mod+Enter")}: correct.`,
        `${k("Alt+←")} / ${k("Alt+→")}: back/forward. ${k("Alt+↓")} / ${k("Alt+↑")}: slower/faster. ${k("Mod+L")}: repeat selection.`,
        `${k("Mod+1")}–9: insert an annotation, such as [laughs].`,
        "Enter splits a turn, Backspace at its start merges. Click the speaker name to give a turn to someone else.",
        `Everything is saved automatically. Mistake? ${k("Mod+Z")}.`,
      ],
    },
    {
      title: "4. Pseudonymise",
      points: [
        "Pseudonymise panel: enter what to replace and with what, for example John → [colleague 1].",
        "A study's rules apply to all its interviews.",
        "You see the pseudonym in the text straight away; point at it for the original. The original is kept and only replaced when exporting.",
        "The audio is not pseudonymised.",
      ],
    },
    {
      title: "5. Quotes",
      points: [
        `Select text and press ${k("Mod+Q")}.`,
        "Export from the Quotes panel or from the study: numbered, with an audio fragment per quote (optionally with an unrecognisable voice and bleeped names).",
      ],
    },
    {
      title: "6. Export",
      points: [
        "Export (top right): Word, text, MAXQDA, ATLAS.ti, NVivo, REFI-QDA (.qdpx) or subtitles.",
        "A whole study at once: open the study and choose Export.",
      ],
    },
    {
      title: "Privacy",
      points: [
        "Recordings and transcripts never leave your computer.",
        "The internet is only used to download speech models and to check for updates (can be turned off in Settings).",
      ],
    },
  ];
}
