// The tour: three short slides shown at startup (until switched off) on how to work in the app.
// The point of the first slide: checking happens here, where every word is synchronised with
// the recording, and exporting comes last.
// In `points`, "{Mod+U}" and the like are shown as keys, in the platform's notation.

import type { Language } from "./types";

export interface TutorialText {
  workflow: {
    kicker: string;
    title: string;
    points: string[];
    steps: string[];
    /** Recording shown being added, its length, and a sentence for the transcript in the drawing. */
    file: string;
    length: string;
    words: string[];
    synced: string;
    exports: string[];
  };
  speakers: {
    kicker: string;
    title: string;
    points: string[];
    interviewer: string;
    respondent: string;
    question: string;
    /** The answer around the selected interjection, and where the dragged notation lands. */
    before: string;
    interjection: string;
    after: string;
    saidBy: string;
    tagsPanel: string;
    tags: string[];
  };
  finish: {
    kicker: string;
    title: string;
    points: string[];
    tiles: { title: string; cue: string }[];
    pseudoFrom: string;
    pseudoTo: string;
  };
}

export function tutorialText(lang: Language): TutorialText {
  if (lang === "nl") {
    return {
      workflow: {
        kicker: "Zo werkt het",
        title: "Nakijken doe je snel, direct in de app",
        points: [
          "Elk woord is gesynchroniseerd met de opname. Klik op een woord: je hoort meteen wat er gezegd wordt en je cursor staat er al. Typ gewoon je verbetering.",
          "{Esc} afspelen of pauzeren, {Alt+←} {Alt+→} terug of vooruit, {Alt+↓} langzamer.",
          "Verbeteren, sprekers, notaties en citaten doe je allemaal op één plek. Klopt alles? Dan exporteer je.",
        ],
        steps: ["Opname toevoegen", "Transcriberen", "Nakijken", "Exporteren"],
        file: "interview-R01.m4a",
        length: "42 min",
        words: ["Ik", "merkte", "vooral", "in", "de", "eerste", "weken", "veel", "stress."],
        synced: "gesynchroniseerd met de opname",
        exports: ["Word", "MAXQDA", "ATLAS.ti", "NVivo"],
      },
      speakers: {
        kicker: "Sprekers en beurten",
        title: "Wie zegt wat?",
        points: [
          "Paneel Sprekers, rechts: geef iedereen een naam. Die verandert overal mee.",
          "Klik op de naam bij een alinea om die beurt aan een ander te geven. {Enter} splitst een beurt, {Backspace} aan het begin voegt hem samen met de vorige.",
          "Zegt de ander iets korts tussendoor? Selecteer het en klik op Gezegd door… eronder.",
          "Paneel Notaties: sleep [lacht] of [stilte] naar de goede plek in de tekst.",
        ],
        interviewer: "Interviewer",
        respondent: "Respondent",
        question: "Hoe ging je eerste week?",
        before: "Ik kende nog niemand,",
        interjection: "ja, klopt",
        after: "dus dat was best even wennen. Maar ik zat al snel in een leuke groep.",
        saidBy: "Gezegd door…",
        tagsPanel: "Notaties",
        tags: ["[lacht]", "[zucht]", "[stilte]"],
      },
      finish: {
        kicker: "Klaar met nakijken",
        title: "Citaten, pseudoniemen, exporteren en delen",
        points: [
          "Citaat: selecteer tekst en druk {Mod+U}. Zo bouw je per studie een citatenlijst op.",
          "Pseudonimiseren: het origineel blijft bewaard, vervangen gebeurt pas bij het exporteren.",
          "Exporteren (rechtsboven) naar Word, MAXQDA, ATLAS.ti of NVivo.",
          "Samenwerken: ⋯ > Delen als ZIP. Je medestudent kiest ZIP importeren, linksonder in het startscherm.",
        ],
        tiles: [
          { title: "Citaat", cue: "{Mod+U} op een selectie" },
          { title: "Pseudonimiseren", cue: "" },
          { title: "Exporteren", cue: "Word, MAXQDA, ATLAS.ti, NVivo" },
          { title: "Delen", cue: "⋯ > Delen als ZIP…" },
        ],
        pseudoFrom: "Jan",
        pseudoTo: "[collega 1]",
      },
    };
  }
  return {
    workflow: {
      kicker: "How it works",
      title: "Checking is quick, right in the app",
      points: [
        "Every word is synchronised with the recording. Click a word: you hear straight away what was said, and your cursor is already there. Just type your correction.",
        "{Esc} play or pause, {Alt+←} {Alt+→} back or forward, {Alt+↓} slower.",
        "Corrections, speakers, annotations and quotes all happen in one place. All correct? Then you export.",
      ],
      steps: ["Add a recording", "Transcribe", "Check", "Export"],
      file: "interview-R01.m4a",
      length: "42 min",
      words: ["Especially", "in", "the", "first", "weeks", "I", "felt", "a", "lot", "of", "stress."],
      synced: "synchronised with the recording",
      exports: ["Word", "MAXQDA", "ATLAS.ti", "NVivo"],
    },
    speakers: {
      kicker: "Speakers and turns",
      title: "Who says what?",
      points: [
        "Speakers panel, on the right: give everyone a name. It changes everywhere.",
        "Click the name next to a paragraph to give that turn to someone else. {Enter} splits a turn, {Backspace} at its start merges it with the previous one.",
        "Does the other person say something short in between? Select it and click Said by… below it.",
        "Annotations panel: drag [laughs] or [silence] to the right place in the text.",
      ],
      interviewer: "Interviewer",
      respondent: "Respondent",
      question: "How was your first week?",
      before: "I didn't know anyone yet,",
      interjection: "yes, right",
      after: "so it took some getting used to. But I soon ended up in a nice group.",
      saidBy: "Said by…",
      tagsPanel: "Annotations",
      tags: ["[laughs]", "[sighs]", "[silence]"],
    },
    finish: {
      kicker: "Done checking",
      title: "Quotes, pseudonyms, export and sharing",
      points: [
        "Quote: select text and press {Mod+U}. That builds a quote list for each study.",
        "Pseudonymise: the original is kept; names are only replaced when you export.",
        "Export (top right) to Word, MAXQDA, ATLAS.ti or NVivo.",
        "Working together: ⋯ > Share as ZIP. Your fellow student chooses Import ZIP, bottom left on the start screen.",
      ],
      tiles: [
        { title: "Quote", cue: "{Mod+U} on a selection" },
        { title: "Pseudonymise", cue: "" },
        { title: "Export", cue: "Word, MAXQDA, ATLAS.ti, NVivo" },
        { title: "Share", cue: "⋯ > Share as ZIP…" },
      ],
      pseudoFrom: "John",
      pseudoTo: "[colleague 1]",
    },
  };
}
