// The manual: one short page, grouped by the steps of the workflow.

import { Lightbulb } from "lucide-react";
import { Frame } from "@/components/Frame";
import { Button } from "@/components/ui";
import { helpSections } from "@/lib/help";
import { useT } from "@/lib/i18n";
import { useApp } from "@/lib/store";

export function HelpScreen() {
  const t = useT();
  const lang = useApp((s) => s.settings.uiLanguage);
  return (
    <Frame title={t("help.title")} onBack={() => useApp.getState().goBack()}>
      <div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-8">
        <section className="flex items-center gap-4 rounded-2xl border border-accent/25 bg-accent-soft px-5 py-4">
          <Lightbulb className="size-5 shrink-0 text-accent" />
          <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-fg-2">{t("tutorial.helpHint")}</p>
          <Button size="sm" variant="primary" onClick={() => useApp.getState().setTutorialOpen(true)}>
            {t("tutorial.openLong")}
          </Button>
        </section>
        {helpSections(lang).map((section) => (
          <section key={section.title} className="rounded-2xl border border-line bg-surface px-5 py-4 shadow-card">
            <h2 className="text-[15px] font-semibold tracking-tight">{section.title}</h2>
            <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-[13px] leading-relaxed text-fg-2 marker:text-muted">
              {section.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Frame>
  );
}
