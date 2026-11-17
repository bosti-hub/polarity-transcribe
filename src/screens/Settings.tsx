// Preferences. Every control applies immediately through updateSettings; there is no save step.

import { FolderOpen, Monitor, Moon, Sun, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Frame } from "@/components/Frame";
import { ModelManager } from "@/components/ModelManager";
import { Button, cx, Dialog, IconButton, Segmented, Select, Slider, Switch } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { comboLabel, isModifierOnly, isTypingKey, keyCombo, keyName } from "@/lib/keys";
import { useApp } from "@/lib/store";
import type { Language, Settings } from "@/lib/types";
import { useUpdates } from "@/lib/updates";
import { LogoMark } from "./Welcome";

const LANGUAGE_OPTIONS: { value: Language; label: string }[] = [
  { value: "nl", label: "Nederlands" },
  { value: "en", label: "English" },
];

export function SettingsScreen() {
  const t = useT();
  const settings = useApp((s) => s.settings);
  const info = useApp((s) => s.info);
  const go = useApp((s) => s.go);
  const update = useApp((s) => s.updateSettings);

  // A first transcription may have raced integrated graphics against the processor since start-up.
  useEffect(() => {
    api.appInfo().then((info) => useApp.setState({ info })).catch(() => {});
  }, []);

  const gpuAvailable = !!info?.gpu;
  const gpuHint = info?.gpu
    ? t("settings.gpuFound", { name: info.gpu })
    : info?.gpuSlower
      ? t("settings.gpuSlower", { name: info.gpuSlower })
      : info?.gpuBuild
        ? t("settings.gpuNone")
        : t("settings.gpuUnavailable");
  const threadOptions = Array.from({ length: info?.cpuThreads ?? 0 }, (_, i) => i + 1);

  const updatePhase = useUpdates((s) => s.phase);
  const checkNow = async () => {
    const result = await useUpdates.getState().check();
    if (result === "none") useApp.getState().toast(t("settings.upToDate"), "info");
    else if (result === "error") useApp.getState().toast(t("settings.checkFailed"), "error");
    else go({ name: "home" }); // the update banner is on the home screen
  };

  const openFolder = () => {
    if (!info) return;
    api.revealInFolder(info.dataDir).catch((e) => useApp.getState().toast(errorMessage(e), "error"));
  };

  return (
    <Frame title={t("settings.title")} onBack={() => useApp.getState().goBack()}>
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-9 px-6 pt-8 pb-16">
        <Section title={t("settings.general")}>
          <Row label={t("settings.uiLanguage")}>
            <Segmented value={settings.uiLanguage} options={LANGUAGE_OPTIONS} onChange={(v) => update({ uiLanguage: v })} />
          </Row>
          <Row label={t("settings.theme")}>
            <Segmented<Settings["theme"]>
              value={settings.theme}
              onChange={(v) => update({ theme: v })}
              options={[
                { value: "system", label: <ThemeLabel icon={<Monitor />} text={t("settings.themeSystem")} /> },
                { value: "light", label: <ThemeLabel icon={<Sun />} text={t("settings.themeLight")} /> },
                { value: "dark", label: <ThemeLabel icon={<Moon />} text={t("settings.themeDark")} /> },
              ]}
            />
          </Row>
        </Section>

        <Section title={t("settings.editorSection")}>
          <Row label={t("settings.rewind")} hint={t("settings.rewindHint")}>
            <Select
              aria-label={t("settings.rewind")}
              value={settings.rewindSeconds}
              onChange={(e) => update({ rewindSeconds: Number(e.target.value) })}
              className="min-w-28"
            >
              {[0, 1, 1.5, 2, 3, 5].map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? t("settings.rewindOff") : `${n.toLocaleString(settings.uiLanguage)} s`}
                </option>
              ))}
            </Select>
          </Row>
          <div className="px-5 py-4">
            <div className="text-xs leading-relaxed text-muted">{t("settings.keysHint", { alt: keyName("Alt") })}</div>
            <div className="mt-3 flex flex-col gap-2.5">
              <KeyRow label={t("settings.keyPlayPause")} value={settings.keyPlayPause} onChange={(v) => update({ keyPlayPause: v })} />
              <KeyRow label={t("settings.keyBack")} value={settings.keyBack} onChange={(v) => update({ keyBack: v })} />
              <KeyRow label={t("settings.keyForward")} value={settings.keyForward} onChange={(v) => update({ keyForward: v })} />
            </div>
          </div>
          <Row label={t("settings.spellcheck")} hint={t("settings.spellcheckHint")}>
            <Switch checked={settings.spellcheck} onChange={(v) => update({ spellcheck: v })} label={t("settings.spellcheck")} />
          </Row>
        </Section>

        <Section title={t("settings.transcription")}>
          <div className="p-5">
            <div className="mb-3 text-[13px] font-medium">{t("models.title")}</div>
            <ModelManager />
          </div>
          <Row label={t("settings.fastMode")} hint={t("settings.fastModeHint")}>
            <Switch checked={settings.fastMode} onChange={(v) => update({ fastMode: v })} label={t("settings.fastMode")} />
          </Row>
          <Row label={t("settings.useGpu")} hint={gpuHint}>
            <Switch
              checked={gpuAvailable && settings.useGpu}
              disabled={!gpuAvailable}
              onChange={(v) => update({ useGpu: v })}
              label={t("settings.useGpu")}
            />
          </Row>
          <Row label={t("settings.threads")}>
            <Select
              aria-label={t("settings.threads")}
              value={settings.threads}
              onChange={(e) => update({ threads: Number(e.target.value) })}
              className="min-w-36"
            >
              <option value={0}>{t("settings.threadsAuto")}</option>
              {threadOptions.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Row>
          <Row label={t("settings.doubtThreshold")}>
            <div className="flex w-64 items-center gap-3 text-xs text-muted">
              <span>{t("settings.doubtLow")}</span>
              <Slider
                className="flex-1"
                label={t("settings.doubtThreshold")}
                value={settings.doubtThreshold}
                min={0.2}
                max={0.8}
                step={0.05}
                onChange={(v) => update({ doubtThreshold: v })}
              />
              <span>{t("settings.doubtHigh")}</span>
            </div>
          </Row>
        </Section>

        <Section title={t("settings.privacy")}>
          <div className="flex flex-col gap-4 p-5">
            <p className="text-[13px] leading-relaxed text-fg-2">{t("settings.privacyText")}</p>
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">{t("settings.dataFolder")}</span>
              <div className="flex items-center gap-2">
                <code className="selectable min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs break-all text-fg-2">
                  {info?.dataDir ?? "—"}
                </code>
                <Button size="md" icon={<FolderOpen className="size-4" />} onClick={openFolder} disabled={!info}>
                  {t("settings.openFolder")}
                </Button>
              </div>
              <span className="text-xs leading-relaxed text-muted">{t("settings.dataFolderHint")}</span>
            </div>
          </div>
          <Row label={t("settings.checkUpdates")} hint={t("settings.checkUpdatesHint")}>
            <div className="flex items-center gap-3">
              <Button size="sm" variant="ghost" onClick={checkNow} disabled={updatePhase === "checking"}>
                {t("settings.checkNow")}
              </Button>
              <Switch checked={settings.checkUpdates} onChange={(v) => update({ checkUpdates: v })} label={t("settings.checkUpdates")} />
            </div>
          </Row>
        </Section>

        <Section title={t("help.title")}>
          <div className="flex items-center justify-between gap-4 p-5">
            <span className="text-[13px] text-fg-2">{t("settings.helpHint")}</span>
            <Button size="sm" variant="secondary" onClick={() => useApp.getState().go({ name: "help" })}>
              {t("settings.openHelp")}
            </Button>
          </div>
        </Section>

        <Section title={t("settings.about")}>
          <div className="flex items-center gap-4 p-5">
            <LogoMark className="size-10" />
            <div className="min-w-0">
              <div className="text-sm font-semibold tracking-tight">Polarity Transcribe</div>
              <div className="mt-0.5 text-xs text-muted">
                {info ? t("settings.version", { v: info.version }) : null}
                {info && " · "}
                {t("settings.license")}
              </div>
              <div className="mt-0.5 text-xs text-muted">© 2026 Floris Bos · OnPolarity.com</div>
              <div className="mt-1.5 flex gap-3 text-xs">
                <button className="text-accent hover:underline" onClick={() => void api.openProjectPage("home").catch((e) => useApp.getState().toast(errorMessage(e), "error"))}>
                  {t("settings.sourceCode")}
                </button>
                <button className="text-accent hover:underline" onClick={() => void api.openProjectPage("issues").catch((e) => useApp.getState().toast(errorMessage(e), "error"))}>
                  {t("settings.reportProblem")}
                </button>
                <SystemInfo />
              </div>
            </div>
          </div>
        </Section>
      </div>
    </Frame>
  );
}

/** "System information": the text to send along with a support question, shown before it is copied. */
function SystemInfo() {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const open = () =>
    api
      .systemInfo()
      .then(setText)
      .catch((e) => useApp.getState().toast(errorMessage(e), "error"));
  const copy = async () => {
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Older webviews: copy through a temporary text field.
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    useApp.getState().toast(t("settings.systemInfoCopied"), "ok");
  };
  return (
    <>
      <button className="text-accent hover:underline" onClick={() => void open()}>
        {t("settings.systemInfo")}
      </button>
      <Dialog
        open={text !== null}
        onOpenChange={(o) => !o && setText(null)}
        title={t("settings.systemInfo")}
        description={t("settings.systemInfoHint")}
        width={680}
        footer={
          <>
            <Button variant="ghost" onClick={() => setText(null)}>
              {t("common.close")}
            </Button>
            <Button variant="primary" onClick={() => void copy()}>
              {t("common.copy")}
            </Button>
          </>
        }
      >
        <pre className="max-h-[50vh] overflow-auto rounded-xl bg-surface-2 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap select-text">{text}</pre>
      </Dialog>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2.5 px-1 text-[13px] font-semibold text-fg-2">{title}</h2>
      <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface shadow-card">{children}</div>
    </section>
  );
}

/** Choose a key by pressing it (works for foot pedals, which send key presses). */
function KeyRow({ label, value, onChange }: { label: string; value: string; onChange: (combo: string) => void }) {
  const t = useT();
  const [listening, setListening] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      if (isModifierOnly(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setListening(false);
      if (e.key === "Escape") return;
      const combo = keyCombo(e);
      if (isTypingKey(combo)) {
        setError(true);
        return;
      }
      setError(false);
      onChange(combo);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listening, onChange]);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 text-[13px]">{label}</span>
        <button
          type="button"
          onClick={() => {
            setError(false);
            setListening(true);
          }}
          onBlur={() => setListening(false)}
          className={cx(
            "h-8 min-w-36 rounded-lg border px-3 text-sm font-medium",
            listening ? "border-accent bg-accent-soft text-accent" : "border-line-strong bg-surface hover:bg-surface-2",
          )}
        >
          {listening ? t("settings.keyPress") : value ? comboLabel(value) : <span className="font-normal text-muted">{t("settings.keyNone")}</span>}
        </button>
        <IconButton label={t("settings.keyClear")} size="sm" disabled={!value} onClick={() => onChange("")}>
          <X className="size-3.5" />
        </IconButton>
      </div>
      {error && <span className="text-xs text-danger">{t("settings.keyTyping")}</span>}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-6 px-5 py-4">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-xs leading-relaxed text-muted">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function ThemeLabel({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 [&>svg]:size-3.5">
      {icon}
      {text}
    </span>
  );
}
