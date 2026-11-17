// The participants of a study: codes, attributes (for analysis software later), the
// interviews each one took part in, and a CSV export of the whole table.

import { Download, Plus, Trash2, UserPlus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, IconButton, TextInput } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { pickSavePath } from "@/lib/platform";
import { useApp } from "@/lib/store";
import type { Participant, Project, Study } from "@/lib/types";

const fail = (e: unknown) => useApp.getState().toast(errorMessage(e), "error");

function csvCell(v: string): string {
  return /[",;\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** The participants as CSV (semicolon-separated in Dutch, as Excel expects there). */
export function participantsCsv(study: Study, projects: Project[], sep: "," | ";"): string {
  const header = ["Code", ...study.attributes, "Interviews"];
  const rows = study.participants.map((p) => [
    p.code,
    ...study.attributes.map((a) => p.attributes[a] ?? ""),
    projects
      .filter((x) => x.participantIds.includes(p.id))
      .map((x) => x.name)
      .join(" | "),
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(sep)).join("\r\n") + "\r\n";
}

export function ParticipantsTable({ study, projects }: { study: Study; projects: Project[] }) {
  const t = useT();
  const lang = useApp((s) => s.settings.uiLanguage);
  const [newAttribute, setNewAttribute] = useState("");

  const save = async (p: Participant) => {
    try {
      useApp.getState().putStudy(await api.saveParticipant(study.id, p));
    } catch (e) {
      fail(e);
    }
  };

  const remove = async (p: Participant) => {
    try {
      useApp.getState().putStudy(await api.deleteParticipant(study.id, p.id));
    } catch (e) {
      fail(e);
    }
  };

  const setAttributes = async (attributes: string[]) => {
    try {
      useApp.getState().putStudy(await api.updateStudy(study.id, { attributes }));
    } catch (e) {
      fail(e);
    }
  };

  const addAttribute = () => {
    const name = newAttribute.trim();
    setNewAttribute("");
    if (name && !study.attributes.some((a) => a.toLowerCase() === name.toLowerCase())) void setAttributes([...study.attributes, name]);
  };

  const exportCsv = async () => {
    try {
      const path = await pickSavePath(`${study.name} - ${t("library.tabParticipants").toLowerCase()}.csv`, "csv");
      if (!path) return;
      // A byte-order mark makes Excel read the accents correctly.
      const text = "﻿" + participantsCsv(study, projects, lang === "nl" ? ";" : ",");
      await api.writeFile(path, new TextEncoder().encode(text));
      useApp.getState().toast(path, "ok");
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="soft" icon={<UserPlus className="size-3.5" />} onClick={() => void save({ id: "", code: "", attributes: {}, notes: "" })}>
          {t("library.addParticipant")}
        </Button>
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            addAttribute();
          }}
        >
          <TextInput
            value={newAttribute}
            onChange={(e) => setNewAttribute(e.target.value)}
            placeholder={t("library.attributePlaceholder")}
            aria-label={t("library.attributeName")}
            className="h-7 w-52 text-[13px]"
          />
          <Button size="sm" type="submit" variant="ghost" icon={<Plus className="size-3.5" />} disabled={!newAttribute.trim()}>
            {t("library.addAttribute")}
          </Button>
        </form>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => void exportCsv()} disabled={study.participants.length === 0}>
          {t("library.exportCsv")}
        </Button>
      </div>

      {study.participants.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line-strong bg-surface px-6 py-10 text-center text-[13px] text-fg-2">{t("library.noParticipants")}</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-surface shadow-card">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="w-24 px-3 py-2 font-medium">{t("library.code")}</th>
                {study.attributes.map((a) => (
                  <th key={a} className="group px-3 py-2 font-medium whitespace-nowrap">
                    <span className="inline-flex items-center gap-1">
                      {a}
                      <button
                        aria-label={`${t("library.removeAttribute")}: ${a}`}
                        className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-surface-3"
                        onClick={() => void setAttributes(study.attributes.filter((x) => x !== a))}
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  </th>
                ))}
                <th className="px-3 py-2 font-medium">{t("library.tabInterviews")}</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {study.participants.map((p) => (
                <ParticipantRow key={p.id} participant={p} study={study} projects={projects} onSave={save} onRemove={remove} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** A table cell that edits one text value and saves when focus leaves it. */
function Cell({ value, onCommit, label, className }: { value: string; onCommit: (v: string) => void; label: string; className?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      value={text}
      aria-label={label}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text.trim() !== value && onCommit(text.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setText(value);
      }}
      className={
        "h-8 w-full min-w-24 rounded-md border border-transparent bg-transparent px-2 outline-none hover:border-line focus:border-accent focus:bg-surface focus:ring-2 focus:ring-accent/20 " +
        (className ?? "")
      }
    />
  );
}

function ParticipantRow({
  participant: p,
  study,
  projects,
  onSave,
  onRemove,
}: {
  participant: Participant;
  study: Study;
  projects: Project[];
  onSave: (p: Participant) => void;
  onRemove: (p: Participant) => void;
}) {
  const t = useT();
  const go = useApp((s) => s.go);
  const interviews = projects.filter((x) => x.participantIds.includes(p.id));
  return (
    <tr className="group border-b border-line last:border-0 hover:bg-surface-2">
      <td className="px-1 py-1">
        <Cell value={p.code} label={t("library.code")} className="font-semibold tabular-nums" onCommit={(code) => code && onSave({ ...p, code })} />
      </td>
      {study.attributes.map((a) => (
        <td key={a} className="px-1 py-1">
          <Cell value={p.attributes[a] ?? ""} label={`${p.code} ${a}`} onCommit={(v) => onSave({ ...p, attributes: { ...p.attributes, [a]: v } })} />
        </td>
      ))}
      <td className="px-3 py-1">
        <span className="flex flex-wrap gap-1">
          {interviews.map((x) => (
            <button
              key={x.id}
              onClick={() => go(x.status === "ready" ? { name: "editor", id: x.id } : { name: "setup", id: x.id })}
              className="max-w-48 truncate rounded-full bg-surface-3 px-2 py-0.5 text-xs text-fg-2 hover:bg-accent-soft hover:text-accent"
            >
              {x.name}
            </button>
          ))}
        </span>
      </td>
      <td className="pr-2">
        <IconButton
          label={interviews.length ? t("library.participantInUse", { n: interviews.length }) : t("library.deleteParticipant")}
          size="sm"
          className="opacity-0 group-hover:opacity-100"
          onClick={() => onRemove(p)}
        >
          <Trash2 className="size-3.5" />
        </IconButton>
      </td>
    </tr>
  );
}
