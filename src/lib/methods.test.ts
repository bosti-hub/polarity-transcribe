import { describe, expect, it } from "vitest";
import { methodsText } from "./methods";

describe("methods paragraph", () => {
  const facts = { n: 12, seconds: 12 * 3600, checked: 10, version: "0.2.0", models: ["ggml-large-v3-turbo-q8_0.bin"], methods: ["delay", "voice"], pause: 3, pseudonyms: true };
  it("describes the study in Dutch and English", () => {
    const nl = methodsText(facts, "nl");
    expect(nl).toContain("(n = 12, samen 12 h 0 min)");
    expect(nl).toContain("Polarity Transcribe 0.2.0");
    expect(nl).toContain("Whisper-model large-v3-turbo");
    expect(nl).toContain("twee microfoons");
    expect(nl).toContain("WeSpeaker");
    expect(nl).toContain("(10 van de 12 transcripten zijn in de app als gecontroleerd gemarkeerd)");
    expect(nl).toContain("pseudoniemen");
    const en = methodsText({ ...facts, checked: 12, pseudonyms: false }, "en");
    expect(en).toContain("transcribed verbatim");
    expect(en).not.toContain("marked as checked");
    expect(en).not.toContain("pseudonyms");
  });
});
