// Speech-model picker: download, pause, verify, select and remove the recogniser models.

import { AlertTriangle, Check, ChevronDown, Download, FileUp, MoreHorizontal, Pause, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { pickFile } from "@/lib/platform";
import { activeModel, useApp } from "@/lib/store";
import type { Language, ModelInfo } from "@/lib/types";
import { Badge, Button, cx, IconButton, Menu, MenuItem, Progress, Spinner } from "./ui";

const fail = (e: unknown) => useApp.getState().toast(errorMessage(e), "error");

/** Bytes as "874 MB" / "1.1 GB", with the decimal separator of the UI language. */
export function formatBytes(bytes: number, lang: Language): string {
  const locale = lang === "nl" ? "nl-NL" : "en-GB";
  if (bytes >= 1e9) {
    return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / 1e9)} GB`;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(bytes / 1e6)} MB`;
}

export function ModelManager({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const models = useApp((s) => s.models);
  const settings = useApp((s) => s.settings);
  const [showMore, setShowMore] = useState(false);
  const [importing, setImporting] = useState(false);

  const active = activeModel(models, settings);
  const recommended = models.find((m) => m.recommended) ?? models[0];
  const primary = compact ? models.filter((m) => m === recommended) : models;
  const others = compact ? models.filter((m) => m !== recommended) : [];

  const importFile = async () => {
    const standard = models.find((m) => m.tier === "standard");
    if (!standard) return;
    try {
      const path = await pickFile("Model", ["bin", "onnx"]);
      if (!path) return;
      setImporting(true);
      await api.importModel(standard.id, path);
      await useApp.getState().refreshModels();
    } catch (e) {
      fail(e);
    } finally {
      setImporting(false);
    }
  };

  if (models.length === 0) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {primary.map((m) => (
        <ModelCard key={m.id} model={m} active={active?.id === m.id} prominent={compact} />
      ))}

      {others.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={showMore}
            onClick={() => setShowMore((v) => !v)}
            className="flex h-8 items-center gap-1.5 self-start rounded-lg px-2 text-[13px] font-medium text-fg-2 transition-colors hover:bg-surface-3 hover:text-fg"
          >
            <ChevronDown className={cx("size-4 transition-transform", showMore && "rotate-180")} />
            {t("models.moreOptions")}
          </button>
          {showMore && (
            <div className="anim-fade flex flex-col gap-2.5">
              {others.map((m) => (
                <ModelCard key={m.id} model={m} active={active?.id === m.id} />
              ))}
            </div>
          )}
        </>
      )}

      <div className="mt-1 flex items-start gap-2.5 px-1">
        <button
          type="button"
          onClick={importFile}
          disabled={importing}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md text-[13px] font-medium text-accent hover:underline disabled:opacity-50"
        >
          {importing ? <Spinner className="size-3.5 text-accent" /> : <FileUp className="size-3.5" />}
          {t("models.importFile")}
        </button>
      </div>
      <p className="-mt-1.5 px-1 text-xs leading-relaxed text-muted">{t("models.importHint")}</p>
    </div>
  );
}

function ModelCard({ model, active, prominent = false }: { model: ModelInfo; active: boolean; prominent?: boolean }) {
  const t = useT();
  const lang = useApp((s) => s.settings.uiLanguage);
  const download = useApp((s) => s.downloads[model.id]);
  const updateSettings = useApp((s) => s.updateSettings);
  const refreshModels = useApp((s) => s.refreshModels);

  const downloading = !model.installed && download?.state === "downloading";
  const verifying = !model.installed && download?.state === "verifying";
  const failed = !model.installed && download?.state === "error";
  // The speech model is complete but its companion voice model is not.
  const extrasBusy = model.installed && (download?.state === "downloading" || download?.state === "verifying");
  const extrasFailed = model.installed && download?.state === "error";

  const start = () => api.downloadModel(model.id).catch(fail);
  const pause = () =>
    api
      .cancelDownload(model.id)
      .then(refreshModels)
      .catch(fail);
  const remove = () =>
    api
      .deleteModel(model.id)
      .then(refreshModels)
      .catch(fail);

  return (
    <div
      className={cx(
        "rounded-xl border bg-surface p-4 transition-colors",
        active ? "border-accent ring-2 ring-accent/15" : "border-line",
        prominent && "p-5",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold tracking-tight">{t(`models.${model.tier}`)}</span>
            {model.recommended && <Badge tone="accent">{t("models.recommended")}</Badge>}
            {model.installed && <Badge tone="ok">{t("models.installed")}</Badge>}
            <span className="tabular-nums text-xs text-muted">{formatBytes(model.sizeBytes, lang)}</span>
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-fg-2">{t(`models.${model.tier}Desc`)}</p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {model.installed ? (
            <>
              {active ? (
                <span className="inline-flex h-7 items-center gap-1.5 rounded-md bg-accent-soft px-2.5 text-[13px] font-medium text-accent">
                  <Check className="size-3.5" />
                  {t("models.inUse")}
                </span>
              ) : (
                <Button size="sm" onClick={() => updateSettings({ model: model.id })}>
                  {t("models.use")}
                </Button>
              )}
              <Menu
                trigger={
                  <IconButton label={t("models.more")} size="sm">
                    <MoreHorizontal className="size-4" />
                  </IconButton>
                }
              >
                <MenuItem danger icon={<Trash2 />} onSelect={remove}>
                  {t("models.remove")}
                </MenuItem>
              </Menu>
            </>
          ) : downloading ? (
            <Button size="sm" variant="ghost" icon={<Pause className="size-3.5" />} onClick={pause}>
              {t("models.pause")}
            </Button>
          ) : verifying ? null : failed ? (
            <Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={start}>
              {t("common.retry")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant={model.recommended ? "primary" : "secondary"}
              icon={<Download className="size-3.5" />}
              onClick={start}
            >
              {model.partialBytes > 0 ? t("models.resume") : t("models.download")}
            </Button>
          )}
        </div>
      </div>

      {downloading && download && (
        <div className="mt-3.5 flex flex-col gap-1.5">
          <Progress value={download.totalBytes > 0 ? download.receivedBytes / download.totalBytes : null} />
          <span className="tabular-nums text-xs text-muted">
            {t("models.downloading", {
              done: formatBytes(download.receivedBytes, lang),
              total: formatBytes(download.totalBytes, lang),
              speed: formatBytes(download.speed, lang),
            })}
          </span>
        </div>
      )}
      {verifying && (
        <div className="mt-3.5 flex items-center gap-2 text-xs text-muted">
          <Spinner className="size-3.5" />
          {t("models.verifying")}
        </div>
      )}
      {failed && (
        <p className="selectable mt-3 text-xs text-danger">{t("models.failed", { error: download?.error ?? "" })}</p>
      )}
      {model.installed && active && model.extrasMissing && (
        <div className="mt-3.5 flex items-start gap-2.5 rounded-lg bg-warn-soft px-3 py-2.5 text-xs leading-relaxed text-fg-2">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warn" />
          <span className="min-w-0 flex-1">
            {t("models.extrasMissing")}
            {extrasFailed && <span className="selectable mt-1 block text-danger">{download?.error}</span>}
          </span>
          <Button size="sm" loading={extrasBusy} icon={<Download className="size-3.5" />} onClick={start}>
            {t("models.extrasDownload")}
          </Button>
        </div>
      )}
      {!model.installed && !downloading && !verifying && !failed && model.partialBytes > 0 && (
        <div className="mt-3.5 flex flex-col gap-1.5 opacity-70">
          <Progress value={model.partialBytes / model.sizeBytes} />
          <span className="tabular-nums text-xs text-muted">
            {formatBytes(model.partialBytes, lang)} / {formatBytes(model.sizeBytes, lang)}
          </span>
        </div>
      )}
    </div>
  );
}
