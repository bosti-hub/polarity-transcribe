// Creating a study, its settings, and deleting it.

import { AlertTriangle, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Button, Callout, Dialog, Field, Segmented, TextInput } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useApp } from "@/lib/store";
import type { Language, Study, StudyPatch } from "@/lib/types";

const fail = (e: unknown) => useApp.getState().toast(errorMessage(e), "error");

const splitList = (text: string) =>
  text
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

function LanguagePicker({ value, onChange }: { value: Language; onChange: (l: Language) => void }) {
  const t = useT();
  return (
    <Segmented<Language>
      value={value}
      onChange={onChange}
      options={[
        { value: "nl", label: t("common.dutch") },
        { value: "en", label: t("common.english") },
      ]}
    />
  );
}

export function NewStudyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const uiLanguage = useApp((s) => s.settings.uiLanguage);
  // Interviews are usually in the language of the previous one, not necessarily the app's.
  const defaultLanguage = (): Language => {
    try {
      const v = localStorage.getItem("pt.interviewLanguage");
      return v === "nl" || v === "en" ? v : uiLanguage;
    } catch {
      return uiLanguage;
    }
  };
  const [name, setName] = useState("");
  const [language, setLanguage] = useState<Language>(defaultLanguage);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setLanguage(defaultLanguage());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, uiLanguage]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const study = await api.createStudy(name.trim(), language);
      try {
        localStorage.setItem("pt.interviewLanguage", language);
      } catch {
        // Remembering is a convenience only.
      }
      const { putStudy, showLibrary, refreshStudies } = useApp.getState();
      putStudy(study);
      showLibrary(study.id);
      void refreshStudies();
      onClose();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("study.createTitle")}
      description={t("study.createHint")}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void submit()}>
            {t("study.create")}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label={t("study.name")}>
          <TextInput autoFocus value={name} placeholder={t("study.namePlaceholder")} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">{t("setup.language")}</span>
          <div>
            <LanguagePicker value={language} onChange={setLanguage} />
          </div>
        </div>
      </form>
    </Dialog>
  );
}

interface Draft {
  name: string;
  language: Language;
  glossary: string;
  pause: string;
  interviewer: string;
  interviewerLabel: string;
  participantPrefix: string;
  tags: string;
  notes: string;
}

function draftOf(s: Study): Draft {
  return {
    name: s.name,
    language: s.language,
    glossary: s.glossary.join(", "),
    pause: String(s.pauseThreshold),
    interviewer: s.interviewer,
    interviewerLabel: s.interviewerLabel,
    participantPrefix: s.participantPrefix,
    tags: s.tags.join(", "),
    notes: s.notes,
  };
}

export function StudySettingsDialog({ study, onClose, onDelete }: { study: Study | null; onClose: () => void; onDelete: (s: Study) => void }) {
  const t = useT();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setDraft(study ? draftOf(study) : null), [study]);
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const pause = Number((draft?.pause ?? "").replace(",", "."));
  const pauseValid = Number.isFinite(pause) && pause >= 1 && pause <= 30;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!study || !draft || !draft.name.trim() || !pauseValid) return;
    const patch: StudyPatch = {
      name: draft.name.trim(),
      language: draft.language,
      glossary: splitList(draft.glossary),
      pauseThreshold: pause,
      interviewer: draft.interviewer,
      interviewerLabel: draft.interviewerLabel,
      participantPrefix: draft.participantPrefix,
      tags: splitList(draft.tags),
      notes: draft.notes,
    };
    setBusy(true);
    try {
      useApp.getState().putStudy(await api.updateStudy(study.id, patch));
      onClose();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={study !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("library.studySettings")}
      width={620}
      footer={
        <>
          <Button
            variant="ghost"
            className="mr-auto text-danger"
            icon={<Trash2 className="size-4" />}
            onClick={() => {
              if (study) onDelete(study);
              onClose();
            }}
          >
            {t("study.delete")}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" loading={busy} disabled={!draft?.name.trim() || !pauseValid} onClick={() => void submit()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      {draft && (
        <form onSubmit={submit} className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          <Field label={t("study.name")} className="sm:col-span-2">
            <TextInput value={draft.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium">{t("setup.language")}</span>
            <div>
              <LanguagePicker value={draft.language} onChange={(language) => set({ language })} />
            </div>
          </div>
          <Field label={t("setup.pauseThreshold")} hint={t("setup.pauseThresholdHint")}>
            <div className="flex items-center gap-2">
              <TextInput type="number" min={1} max={30} step={0.5} value={draft.pause} aria-invalid={!pauseValid} className="tabular w-24" onChange={(e) => set({ pause: e.target.value })} />
              <span className="text-[13px] text-fg-2">{t("setup.seconds")}</span>
            </div>
          </Field>
          <Field label={t("setup.glossary")} hint={t("study.glossaryHint")} className="sm:col-span-2">
            <TextInput value={draft.glossary} spellCheck placeholder={t("setup.glossaryPlaceholder")} onChange={(e) => set({ glossary: e.target.value })} />
          </Field>
          <Field label={t("study.interviewer")} hint={t("study.interviewerHint")}>
            <TextInput value={draft.interviewer} onChange={(e) => set({ interviewer: e.target.value })} />
          </Field>
          <Field label={t("study.participantPrefix")} hint={t("study.participantPrefixHint")}>
            <TextInput value={draft.participantPrefix} maxLength={8} className="w-24" onChange={(e) => set({ participantPrefix: e.target.value })} />
          </Field>
          <Field label={t("study.interviewerLabel")} hint={t("study.interviewerLabelHint")} className="sm:col-span-2">
            <TextInput value={draft.interviewerLabel} className="max-w-60" onChange={(e) => set({ interviewerLabel: e.target.value })} />
          </Field>
          <Field label={t("study.tags")} hint={t("study.tagsHint")} className="sm:col-span-2">
            <TextInput value={draft.tags} onChange={(e) => set({ tags: e.target.value })} />
          </Field>
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-[13px] font-medium">{t("study.notes")}</span>
            <textarea
              value={draft.notes}
              rows={3}
              spellCheck
              onChange={(e) => set({ notes: e.target.value })}
              className="w-full resize-y rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm leading-relaxed outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </label>
        </form>
      )}
    </Dialog>
  );
}

export function DeleteStudyDialog({ study, interviews, onClose, onDone }: { study: Study | null; interviews: number; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState<"all" | "study" | null>(null);

  const run = async (deleteInterviews: boolean) => {
    if (!study) return;
    setBusy(deleteInterviews ? "all" : "study");
    try {
      await api.deleteStudy(study.id, deleteInterviews);
      const { refreshStudies, showLibrary, library } = useApp.getState();
      await refreshStudies();
      if (library === study.id) showLibrary("all");
      onDone();
      onClose();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open={study !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("library.deleteStudyTitle")}
      description={study ? t("library.deleteStudyBody", { name: study.name, n: interviews }) : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="soft" loading={busy === "study"} onClick={() => void run(false)}>
            {t("library.deleteStudyOnly")}
          </Button>
          {interviews > 0 && (
            <Button variant="danger" loading={busy === "all"} icon={<Trash2 className="size-4" />} onClick={() => void run(true)}>
              {t("library.deleteStudyAll")}
            </Button>
          )}
        </>
      }
    >
      {interviews > 0 && (
        <div className="[&>div]:bg-surface-2 [&>div]:text-fg-2">
          <Callout tone="warn" icon={<AlertTriangle />}>
            {t("home.deleteNote")}
          </Callout>
        </div>
      )}
    </Dialog>
  );
}
