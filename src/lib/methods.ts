// A methods paragraph for a thesis or article, from what the app knows about a study.

import { formatDuration } from "./transcript";
import type { Language } from "./types";

export interface MethodsFacts {
  n: number;
  seconds: number;
  checked: number;
  version: string;
  models: string[];
  methods: string[];
  pause: number;
  pseudonyms: boolean;
}

const MODEL_NAMES: Record<string, string> = {
  "ggml-large-v3-turbo-q8_0.bin": "large-v3-turbo",
  "ggml-large-v3-turbo.bin": "large-v3-turbo",
  "ggml-large-v3-q5_0.bin": "large-v3",
  "ggml-small-q5_1.bin": "small",
};

/** The methods paragraph in Dutch or English, from what the app knows about the study. */
export function methodsText(f: MethodsFacts, lang: Language): string {
  const models = f.models.map((m) => MODEL_NAMES[m] ?? m.replace(/^ggml-|\.bin$/g, "")).join(", ") || "large-v3-turbo";
  const nl = lang === "nl";
  const speakerSentences: Record<string, [string, string]> = {
    own_mic: ["Sprekers zijn toegewezen op basis van een eigen microfoon per spreker.", "Speakers were attributed using a separate microphone per speaker."],
    delay: ["Sprekers zijn onderscheiden op basis van het tijdsverschil waarmee hun stem twee microfoons bereikte.", "Speakers were distinguished by the time difference with which their voice reached two microphones."],
    voice: ["Sprekers zijn onderscheiden op basis van stemkenmerken (sprekerherkenning met het WeSpeaker-model).", "Speakers were distinguished by voice characteristics (speaker embeddings from the WeSpeaker model)."],
  };
  const speakers = f.methods.filter((m) => m in speakerSentences).map((m) => speakerSentences[m][nl ? 0 : 1]).join(" ");
  const duration = formatDuration(f.seconds);
  const review =
    f.checked === f.n
      ? ""
      : nl
        ? ` (${f.checked} van de ${f.n} transcripten zijn in de app als gecontroleerd gemarkeerd)`
        : ` (${f.checked} of the ${f.n} transcripts are marked as checked in the app)`;
  if (nl) {
    return [
      `De interviews (n = ${f.n}, samen ${duration}) zijn letterlijk getranscribeerd met Polarity Transcribe ${f.version}, open-sourcesoftware die volledig op de eigen computer werkt: de opnames zijn niet naar externe diensten verstuurd.`,
      `Voor de spraakherkenning is het Whisper-model ${models} (OpenAI) gebruikt, uitgevoerd met whisper.cpp.`,
      `Opvulwoorden zoals ‘eh’ en ‘uhm’ zijn behouden, stiltes van ${f.pause.toLocaleString("nl-NL")} seconden of langer zijn met hun duur gemarkeerd en korte reacties van de luisteraar zijn binnen de beurt van de spreker weergegeven.`,
      speakers,
      `De automatisch gemaakte transcripten zijn daarna door de onderzoeker aan de hand van de audio gecontroleerd en gecorrigeerd${review}.`,
      f.pseudonyms ? "Namen en andere herleidbare gegevens zijn vervangen door pseudoniemen; de sleutel daarvan is apart van de transcripten bewaard." : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  return [
    `The interviews (n = ${f.n}, ${duration} in total) were transcribed verbatim with Polarity Transcribe ${f.version}, open-source software that runs entirely on the researcher's computer: no recordings were sent to external services.`,
    `Speech recognition used the Whisper model ${models} (OpenAI), run with whisper.cpp.`,
    `Filler words such as ‘uh’ and ‘um’ were kept, silences of ${f.pause} seconds or longer were marked with their duration, and the listener's short responses were shown within the speaker's turn.`,
    speakers,
    `The automatic transcripts were then checked and corrected against the audio by the researcher${review}.`,
    f.pseudonyms ? "Names and other identifying details were replaced by pseudonyms; the key was stored separately from the transcripts." : "",
  ]
    .filter(Boolean)
    .join(" ");
}
