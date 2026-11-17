// "A new version is available" on the home screen, with a one-click update.

import { Download } from "lucide-react";
import { Button, Callout, Progress } from "@/components/ui";
import { useT } from "@/lib/i18n";
import { useApp } from "@/lib/store";
import { useUpdates } from "@/lib/updates";

export function UpdateBanner() {
  const t = useT();
  const { phase, version, progress, error, dismissed, install, dismiss } = useUpdates();
  // Installing closes the app: wait until no transcription is running.
  const busy = useApp((s) => Object.values(s.jobs).some((j) => j.state === "running"));

  if (phase === "error") {
    return (
      <Callout tone="danger" icon={<Download />}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="flex-1">{t("update.failed", { e: error ?? "" })}</span>
          <Button size="sm" variant="soft" onClick={install}>
            {t("common.retry")}
          </Button>
        </div>
      </Callout>
    );
  }
  if (phase === "downloading" || phase === "installing") {
    return (
      <Callout tone="accent" icon={<Download />}>
        <div className="flex flex-col gap-2">
          <span className="font-medium">
            {phase === "installing" ? t("update.installing") : t("update.downloading", { v: version ?? "" })}
          </span>
          <Progress value={progress} />
        </div>
      </Callout>
    );
  }
  if (phase !== "available" || dismissed) return null;
  return (
    <Callout tone="accent" icon={<Download />}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex-1">
          <span className="font-medium">{t("update.available", { v: version ?? "" })}</span>
          {busy && <span className="block text-xs text-fg-2">{t("update.busy")}</span>}
        </span>
        <Button size="sm" variant="ghost" onClick={dismiss}>
          {t("update.later")}
        </Button>
        <Button size="sm" variant="primary" onClick={install} disabled={busy}>
          {t("update.now")}
        </Button>
      </div>
    </Callout>
  );
}
