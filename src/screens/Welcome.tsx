// First-run onboarding: introduce the app, pick a language, then install a speech model.

import { AlertTriangle, ArrowRight, AudioLines, Lock, Mic2 } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { ModelManager } from "@/components/ModelManager";
import { Button, Callout, cx, Segmented } from "@/components/ui";
import { useT } from "@/lib/i18n";
import { activeModel, useApp } from "@/lib/store";
import type { Language } from "@/lib/types";

/** App mark: five rounded bars like a waveform on an accent square. */
export function LogoMark({ className }: { className?: string }) {
  const bars = [
    { x: 9, h: 10 },
    { x: 15, h: 18 },
    { x: 21, h: 26 },
    { x: 27, h: 16 },
    { x: 33, h: 8 },
  ];
  return (
    <svg viewBox="0 0 48 48" aria-hidden className={cx("size-12", className)}>
      <rect width="48" height="48" rx="13" className="fill-accent" />
      {bars.map((b) => (
        <rect key={b.x} x={b.x} y={24 - b.h / 2} width="4" height={b.h} rx="2" className="fill-accent-fg" />
      ))}
    </svg>
  );
}

/** Native names, so each option is recognisable whatever the current language. */
const LANGUAGE_OPTIONS: { value: Language; label: string }[] = [
  { value: "nl", label: "Nederlands" },
  { value: "en", label: "English" },
];

export function Welcome() {
  const t = useT();
  const [step, setStep] = useState<1 | 2>(1);
  const settings = useApp((s) => s.settings);
  const models = useApp((s) => s.models);
  const info = useApp((s) => s.info);
  const updateSettings = useApp((s) => s.updateSettings);

  const hasModel = activeModel(models, settings) !== null;
  const finish = () => updateSettings({ onboarded: true });

  return (
    <div className="flex h-full overflow-y-auto bg-bg">
      <div className="m-auto w-full max-w-[560px] px-6 py-10">
        <div className="anim-pop rounded-2xl border border-line bg-surface shadow-pop">
          <div className="flex items-center justify-center gap-1.5 pt-5" aria-hidden>
            {[1, 2].map((n) => (
              <span
                key={n}
                className={cx("h-1.5 rounded-full transition-all duration-300", n === step ? "w-6 bg-accent" : "w-1.5 bg-line-strong")}
              />
            ))}
          </div>

          {step === 1 ? (
            <div key="s1" className="anim-fade px-8 pt-6 pb-8">
              <div className="flex flex-col items-center text-center">
                <LogoMark className="size-14 drop-shadow-sm" />
                <h1 className="mt-5 text-[22px] font-semibold tracking-tight text-balance">{t("welcome.title")}</h1>
                <p className="mt-2 max-w-sm text-[15px] leading-relaxed text-pretty text-fg-2">{t("welcome.lead")}</p>
              </div>

              <div className="mt-7 flex items-center justify-between gap-4 rounded-xl bg-surface-2 px-4 py-3">
                <span className="text-[13px] font-medium" id="welcome-lang">
                  {t("welcome.chooseLanguage")}
                </span>
                <div aria-labelledby="welcome-lang">
                  <Segmented
                    size="sm"
                    value={settings.uiLanguage}
                    options={LANGUAGE_OPTIONS}
                    onChange={(v) => updateSettings({ uiLanguage: v })}
                  />
                </div>
              </div>

              <ul className="mt-6 flex flex-col gap-4">
                <Point icon={<Lock />} title={t("welcome.p1")} body={t("welcome.p1d")} />
                <Point icon={<AudioLines />} title={t("welcome.p2")} body={t("welcome.p2d")} />
                <Point icon={<Mic2 />} title={t("welcome.p3")} body={t("welcome.p3d")} />
              </ul>

              <Button
                variant="primary"
                size="lg"
                className="mt-8 w-full"
                onClick={() => setStep(2)}
                autoFocus
              >
                {t("common.continue")}
                <ArrowRight className="size-4" />
              </Button>
            </div>
          ) : (
            <div key="s2" className="anim-fade px-8 pt-6 pb-8">
              <h1 className="text-[20px] font-semibold tracking-tight">{t("models.title")}</h1>
              <p className="mt-1.5 text-sm leading-relaxed text-fg-2">{t("models.intro")}</p>

              {info?.cpuSupported === false && (
                <div className="mt-4">
                  <Callout tone="danger" icon={<AlertTriangle />}>
                    {t("models.cpuUnsupported")}
                  </Callout>
                </div>
              )}

              <div className="mt-5">
                <ModelManager compact />
              </div>

              <div className="mt-7 flex items-center gap-2">
                <Button variant="ghost" onClick={() => setStep(1)}>
                  {t("common.back")}
                </Button>
                <div className="flex-1" />
                {!hasModel && (
                  <Button variant="ghost" onClick={finish}>
                    {t("welcome.skip")}
                  </Button>
                )}
                <Button variant="primary" disabled={!hasModel} onClick={finish}>
                  {t("welcome.start")}
                  <ArrowRight className="size-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Point({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <li className="flex gap-3.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent [&>svg]:size-[18px]">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <div className="mt-0.5 text-[13px] leading-relaxed text-fg-2">{body}</div>
      </div>
    </li>
  );
}
