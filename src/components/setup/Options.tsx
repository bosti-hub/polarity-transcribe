// Interview language, verbatim or clean text, pause threshold and glossary. Text fields keep
// local state and save through a debounced patch so typing never waits on the backend.

import { useState } from "react";
import { Field, Segmented, Switch, TextInput } from "@/components/ui";
import { useT } from "@/lib/i18n";
import type { Language, Project, ProjectPatch } from "@/lib/types";

/** Save a patch; `debounceKey` groups rapid edits of one field into a single save. */
export type PatchFn = (patch: ProjectPatch, debounceKey?: string) => void;

function parseGlossary(text: string): string[] {
  return text
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function Options({ project, onPatch }: { project: Project; onPatch: PatchFn }) {
  const t = useT();
  const [pause, setPause] = useState(String(project.pauseThreshold));
  const [glossary, setGlossary] = useState(project.glossary.join(", "));

  const pauseValue = Number(pause.replace(",", "."));
  const pauseValid = pause.trim() !== "" && Number.isFinite(pauseValue) && pauseValue >= 1 && pauseValue <= 30;

  return (
    <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
      {/* Not a <label>: clicking it would press the first option. */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-fg">{t("setup.language")}</span>
        <div>
          <Segmented<Language>
            value={project.language}
            onChange={(language) => {
              try {
                localStorage.setItem("pt.interviewLanguage", language);
              } catch {
                // Remembering the choice is a convenience only.
              }
              onPatch({ language });
            }}
            options={[
              { value: "nl", label: t("common.dutch") },
              { value: "en", label: t("common.english") },
            ]}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-fg">{t("setup.verbatim")}</span>
        <label className="flex min-h-9 cursor-pointer items-center gap-2.5 text-sm">
          <Switch checked={project.verbatim} onChange={(verbatim) => onPatch({ verbatim })} label={t("setup.verbatim")} />
          <span className="text-fg-2">{project.verbatim ? t("setup.verbatimOn") : t("setup.verbatimOff")}</span>
        </label>
        <span className="text-xs leading-relaxed text-muted">{t("setup.verbatimHint")}</span>
      </div>

      {/* Pause tags only exist in a verbatim transcript. */}
      {project.verbatim && (
        <Field label={t("setup.pauseThreshold")} hint={t("setup.pauseThresholdHint")}>
          <div className="flex items-center gap-2">
            <TextInput
              type="number"
              min={1}
              max={30}
              step={0.5}
              value={pause}
              aria-invalid={!pauseValid}
              className="tabular w-24"
              onChange={(e) => {
                const text = e.target.value;
                setPause(text);
                const v = Number(text.replace(",", "."));
                if (text.trim() !== "" && Number.isFinite(v) && v >= 1 && v <= 30) onPatch({ pauseThreshold: v }, "pause");
              }}
              onBlur={() => {
                const v = Number.isFinite(pauseValue) ? Math.min(30, Math.max(1, Math.round(pauseValue * 2) / 2)) : project.pauseThreshold;
                setPause(String(v));
                if (v !== project.pauseThreshold) onPatch({ pauseThreshold: v }, "pause");
              }}
            />
            <span className="text-[13px] text-fg-2">{t("setup.seconds")}</span>
          </div>
        </Field>
      )}

      <Field label={t("setup.glossary")} hint={t("setup.glossaryHint")} className="md:col-span-2">
        <TextInput
          value={glossary}
          placeholder={t("setup.glossaryPlaceholder")}
          spellCheck
          onChange={(e) => {
            setGlossary(e.target.value);
            onPatch({ glossary: parseGlossary(e.target.value) }, "glossary");
          }}
        />
      </Field>
    </div>
  );
}
