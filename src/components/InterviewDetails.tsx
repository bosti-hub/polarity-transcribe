// Interview details: study, participant, date, interviewer, tags, notes and review progress.
// Used on the setup screen and in the editor's side panel. Text fields save after a short
// pause; pending saves are written when the form closes.

import { Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cx, Field, Segmented, Select, TextInput } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { interviewDate, isoDay } from "@/lib/interviews";
import { useApp } from "@/lib/store";
import type { Project, ProjectPatch, Review } from "@/lib/types";

const fail = (e: unknown) => useApp.getState().toast(errorMessage(e), "error");

const REVIEWS: Review[] = ["todo", "checked", "anonymised", "done"];
const NEW_PARTICIPANT = "__new__";

/** Debounced saves per field; flushed on unmount. */
function useSaves(projectId: string, onSaved: (p: Project) => void) {
  const pending = useRef(new Map<string, { timer: number; patch: ProjectPatch }>());
  const saved = useRef(onSaved);
  saved.current = onSaved;

  const save = useCallback(
    (patch: ProjectPatch, key?: string) => {
      const run = (p: ProjectPatch) => api.updateProject(projectId, p).then((x) => saved.current(x), fail);
      if (!key) return void run(patch);
      const prev = pending.current.get(key);
      if (prev) clearTimeout(prev.timer);
      const timer = window.setTimeout(() => {
        pending.current.delete(key);
        void run(patch);
      }, 500);
      pending.current.set(key, { timer, patch });
    },
    [projectId],
  );

  useEffect(
    () => () => {
      for (const { timer, patch } of pending.current.values()) {
        clearTimeout(timer);
        void api.updateProject(projectId, patch).catch(fail);
      }
      pending.current.clear();
    },
    [projectId],
  );
  return save;
}

export function InterviewDetails({
  project,
  onChange,
  compact = false,
}: {
  project: Project;
  onChange: (p: Project) => void;
  /** Single column, for the editor's side panel. */
  compact?: boolean;
}) {
  const t = useT();
  const studies = useApp((s) => s.studies);
  const study = studies.find((s) => s.id === project.studyId);
  const save = useSaves(project.id, onChange);

  const [interviewer, setInterviewer] = useState(project.interviewer);
  const [notes, setNotes] = useState(project.notes);
  const [tagDraft, setTagDraft] = useState("");
  useEffect(() => setInterviewer(project.interviewer), [project.id]);
  useEffect(() => setNotes(project.notes), [project.id]);

  const moveToStudy = async (studyId: string) => {
    try {
      onChange(await api.updateProject(project.id, { studyId }));
      await useApp.getState().refreshStudies();
    } catch (e) {
      fail(e);
    }
  };

  const [addingParticipant, setAddingParticipant] = useState(false);

  /** Set the participants; NEW_PARTICIPANT in the list creates one with the next code. */
  const setParticipants = async (ids: string[]) => {
    if (!study) return;
    try {
      const resolved: string[] = [];
      for (const id of ids) {
        if (id === NEW_PARTICIPANT) {
          const updated = await api.saveParticipant(study.id, { id: "", code: "", attributes: {}, notes: "" });
          useApp.getState().putStudy(updated);
          resolved.push(updated.participants[updated.participants.length - 1].id);
        } else if (id) resolved.push(id);
      }
      onChange(await api.updateProject(project.id, { participantIds: [...new Set(resolved)] }));
      // Blank participants that nobody uses any more are removed by the backend.
      await useApp.getState().refreshStudies();
    } catch (e) {
      fail(e);
    }
  };
  const chooseParticipant = (value: string) => void setParticipants(value ? [value] : []);
  const addParticipant = (value: string) => {
    setAddingParticipant(false);
    if (value) void setParticipants([...project.participantIds, value]);
  };

  const addTag = (raw: string) => {
    const tag = raw.trim().replace(/,$/, "").trim();
    setTagDraft("");
    if (!tag || project.tags.some((x) => x.toLowerCase() === tag.toLowerCase())) return;
    const tags = [...project.tags, tag];
    onChange({ ...project, tags });
    save({ tags });
    if (study && !study.tags.some((x) => x.toLowerCase() === tag.toLowerCase())) {
      useApp.getState().putStudy({ ...study, tags: [...study.tags, tag] });
    }
  };

  const removeTag = (tag: string) => {
    const tags = project.tags.filter((x) => x !== tag);
    onChange({ ...project, tags });
    save({ tags });
  };

  const suggestions = (study?.tags ?? []).filter((x) => !project.tags.some((y) => y.toLowerCase() === x.toLowerCase()));
  const listId = `tags-${project.id}`;
  const dateValue = project.interviewDate ?? isoDay(interviewDate(project));

  return (
    <div className={cx("grid gap-x-8 gap-y-5", !compact && "md:grid-cols-2")}>
      <Field label={t("interview.study")}>
        <Select value={project.studyId ?? ""} onChange={(e) => void moveToStudy(e.target.value)} className="w-full">
          <option value="">{t("library.noStudy")}</option>
          {studies.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </Field>

      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-fg">{t("interview.participants")}</span>
        {!study ? (
          <span className="flex h-9 items-center text-[13px] text-muted">{t("library.notInStudy")}</span>
        ) : project.participantIds.length <= 1 ? (
          <Select value={project.participantIds[0] ?? ""} onChange={(e) => chooseParticipant(e.target.value)} className="w-full" aria-label={t("interview.participants")}>
            <option value="">{t("interview.noParticipant")}</option>
            {study.participants.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code}
              </option>
            ))}
            <option value={NEW_PARTICIPANT}>+ {t("interview.newParticipant")}</option>
          </Select>
        ) : (
          <div className="flex min-h-9 flex-wrap items-center gap-1.5">
            {project.participantIds.map((id) => (
              <span key={id} className="inline-flex h-6 items-center gap-1 rounded-full bg-accent-soft pr-1 pl-2.5 text-xs font-semibold text-accent">
                {study.participants.find((p) => p.id === id)?.code ?? "?"}
                <button
                  type="button"
                  aria-label={t("common.remove")}
                  className="rounded-full p-0.5 hover:bg-accent/15"
                  onClick={() => void setParticipants(project.participantIds.filter((x) => x !== id))}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        {study && project.participantIds.length >= 1 && (addingParticipant || project.participantIds.length > 1) && (
          <Select value="" onChange={(e) => addParticipant(e.target.value)} className="w-full" aria-label={t("interview.addParticipant")}>
            <option value="">+ {t("interview.addParticipant")}</option>
            {study.participants
              .filter((p) => !project.participantIds.includes(p.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code}
                </option>
              ))}
            <option value={NEW_PARTICIPANT}>+ {t("interview.newParticipant")}</option>
          </Select>
        )}
        {study && project.participantIds.length === 1 && !addingParticipant && (
          <button type="button" className="self-start text-xs text-accent hover:underline" onClick={() => setAddingParticipant(true)}>
            + {t("interview.addParticipantHint")}
          </button>
        )}
      </div>

      <Field label={t("interview.date")} hint={project.interviewDate ? undefined : t("interview.dateHint")}>
        <TextInput
          type="date"
          value={dateValue}
          onChange={(e) => {
            onChange({ ...project, interviewDate: e.target.value || null });
            save({ interviewDate: e.target.value }, "date");
          }}
        />
      </Field>

      <Field label={t("interview.interviewer")}>
        <TextInput
          value={interviewer}
          onChange={(e) => {
            setInterviewer(e.target.value);
            save({ interviewer: e.target.value }, "interviewer");
          }}
        />
      </Field>

      <div className={cx("flex flex-col gap-1.5", !compact && "md:col-span-2")}>
        <span className="text-[13px] font-medium text-fg">{t("interview.tags")}</span>
        <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2 py-1.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
          {project.tags.map((tag) => (
            <span key={tag} className="inline-flex h-6 items-center gap-1 rounded-full bg-accent-soft pr-1 pl-2.5 text-xs font-medium text-accent">
              {tag}
              <button type="button" aria-label={`${t("common.remove")} ${tag}`} className="rounded-full p-0.5 hover:bg-accent/15" onClick={() => removeTag(tag)}>
                <X className="size-3" />
              </button>
            </span>
          ))}
          <input
            list={listId}
            value={tagDraft}
            placeholder={project.tags.length ? "" : t("interview.tagPlaceholder")}
            aria-label={t("interview.tagPlaceholder")}
            onChange={(e) => {
              const v = e.target.value;
              // Picking a suggestion from the list fills in the whole tag at once.
              if (suggestions.includes(v)) addTag(v);
              else if (v.endsWith(",")) addTag(v);
              else setTagDraft(v);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTag(tagDraft);
              } else if (e.key === "Backspace" && !tagDraft && project.tags.length) {
                removeTag(project.tags[project.tags.length - 1]);
              }
            }}
            onBlur={() => tagDraft.trim() && addTag(tagDraft)}
            className="tag-input h-6 min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
          />
          <datalist id={listId}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          {tagDraft.trim() && (
            <button type="button" className="text-accent" aria-label={t("interview.tagPlaceholder")} onClick={() => addTag(tagDraft)}>
              <Plus className="size-4" />
            </button>
          )}
        </div>
      </div>

      <div className={cx("flex flex-col gap-1.5", !compact && "md:col-span-2")}>
        <span className="text-[13px] font-medium text-fg">{t("interview.notes")}</span>
        <textarea
          value={notes}
          rows={compact ? 6 : 3}
          spellCheck
          placeholder={t("interview.notesPlaceholder")}
          onChange={(e) => {
            setNotes(e.target.value);
            save({ notes: e.target.value }, "notes");
          }}
          className="w-full resize-y rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm leading-relaxed text-fg outline-none placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
      </div>

      {project.status === "ready" && (
        <div className={cx("flex flex-col gap-1.5", !compact && "md:col-span-2")}>
          <span className="text-[13px] font-medium text-fg">{t("interview.review")}</span>
          {compact ? (
            <Select
              value={project.review}
              onChange={(e) => {
                const review = e.target.value as Review;
                onChange({ ...project, review });
                save({ review });
              }}
              className="w-full"
            >
              {REVIEWS.map((r) => (
                <option key={r} value={r}>
                  {t(`interview.review_${r}`)}
                </option>
              ))}
            </Select>
          ) : (
            <div>
              <Segmented<Review>
                value={project.review}
                onChange={(review) => {
                  onChange({ ...project, review });
                  save({ review });
                }}
                options={REVIEWS.map((r) => ({ value: r, label: t(`interview.review_${r}`) }))}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
