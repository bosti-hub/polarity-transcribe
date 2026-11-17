// Shared page chrome: a slim header (back, title, actions) above a scrollable body.

import { ArrowLeft, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { cx, IconButton, Tooltip } from "./ui";

export function Frame({
  title,
  subtitle,
  onBack,
  actions,
  children,
  bodyClassName,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onBack?: () => void;
  actions?: ReactNode;
  children: ReactNode;
  /** Classes for the body; defaults to a centred, scrollable column. */
  bodyClassName?: string;
}) {
  const t = useT();
  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
        {onBack && (
          <IconButton label={t("common.back")} onClick={onBack}>
            <ArrowLeft className="size-[18px]" />
          </IconButton>
        )}
        <div className={cx("min-w-0 flex-1", !onBack && "pl-2")}>
          <div className="truncate text-[15px] font-semibold tracking-tight">{title}</div>
          {subtitle && <div className="truncate text-xs text-muted">{subtitle}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
      </header>
      <main className={bodyClassName ?? "min-h-0 flex-1 overflow-y-auto"}>{children}</main>
    </div>
  );
}

/** Small reassurance shown where people decide to trust the app with their data. */
export function OfflineBadge() {
  const t = useT();
  return (
    <Tooltip label={t("settings.privacyText")}>
      <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-ok-soft px-2.5 text-xs font-medium text-ok">
        <ShieldCheck className="size-3.5" />
        {t("common.offline")}
      </span>
    </Tooltip>
  );
}
