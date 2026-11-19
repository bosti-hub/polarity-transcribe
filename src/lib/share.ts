// Passing work on to a colleague: a whole study or one interview as a ZIP file, and importing
// such a file. The archive is written and read by the backend (it holds the audio, which can be
// hundreds of megabytes for a study).

import { shareFileName } from "@/export/common";
import { api, errorMessage } from "./api";
import type { TFn } from "./i18n";
import { pickFile, pickSavePath } from "./platform";
import { useApp } from "./store";
import type { Language, Project, Study } from "./types";

const toast = (...args: Parameters<ReturnType<typeof useApp.getState>["toast"]>) => useApp.getState().toast(...args);

/**
 * Ask where to save, then write the study (all its transcribed interviews) or the one interview
 * to a ZIP file. `inStudy` is how many interviews the study has, to say how many were left out.
 */
export async function exportShare(t: TFn, what: { study: Study; inStudy: number } | { project: Project }): Promise<void> {
  const name = "study" in what ? what.study.name : what.project.name;
  const path = await pickSavePath(shareFileName(name, new Date()), "zip");
  if (!path) return;
  const busy = toast(t("share.exporting"));
  try {
    const n =
      "study" in what
        ? await api.exportArchive(what.study.id, [], path)
        : await api.exportArchive(null, [what.project.id], path);
    const left = "study" in what ? what.inStudy - n : 0;
    useApp.getState().dismissToast(busy);
    toast(t(left > 0 ? "share.exportedSome" : "share.exported", { n, left }), "ok", {
      label: t("export.show"),
      run: () => void api.revealInFolder(path),
    });
  } catch (e) {
    useApp.getState().dismissToast(busy);
    toast(errorMessage(e), "error");
  }
}

/** Import a ZIP file (picked here when no path is given) and show what came in. */
export async function importShare(t: TFn, lang: Language, path?: string): Promise<boolean> {
  const file = path ?? (await pickFile("ZIP", ["zip"]));
  if (!file) return false;
  const busy = toast(t("share.importing"));
  try {
    const date = new Intl.DateTimeFormat(lang === "nl" ? "nl-NL" : "en-GB", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date());
    const got = await api.importArchive(file, t("share.copySuffix", { date }));
    useApp.getState().dismissToast(busy);
    const { refreshStudies, showLibrary } = useApp.getState();
    const studies = await refreshStudies();
    const study = studies.find((s) => s.id === got.studyId);
    if (study) showLibrary(study.id);
    toast(
      study
        ? t(got.newStudy ? "share.importedStudy" : "share.importedInto", { n: got.interviews, name: study.name })
        : t("share.imported", { n: got.interviews }),
      "ok",
    );
    return true;
  } catch (e) {
    useApp.getState().dismissToast(busy);
    toast(errorMessage(e), "error");
    return false;
  }
}
