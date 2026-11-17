import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useEffect } from "react";
import { cx, Spinner, TooltipProvider } from "./components/ui";
import { errorMessage, events } from "./lib/api";
import { useApp } from "./lib/store";
import { Editor } from "./screens/Editor";
import { Home } from "./screens/Home";
import { ProgressScreen } from "./screens/Progress";
import { SettingsScreen } from "./screens/Settings";
import { HelpScreen } from "./screens/Help";
import { Setup } from "./screens/Setup";
import { Welcome } from "./screens/Welcome";

function useTheme() {
  const theme = useApp((s) => s.settings.theme);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
}

function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-96 max-w-[90vw] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="anim-pop pointer-events-auto flex items-start gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-3 text-[13px] shadow-pop"
        >
          <span className={cx("mt-0.5", t.tone === "error" ? "text-danger" : t.tone === "ok" ? "text-ok" : "text-accent")}>
            {t.tone === "error" ? <AlertCircle className="size-4" /> : t.tone === "ok" ? <CheckCircle2 className="size-4" /> : <Info className="size-4" />}
          </span>
          <span className="selectable min-w-0 flex-1 break-words">{t.message}</span>
          {t.action && (
            <button
              className="shrink-0 font-medium text-accent hover:underline"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button aria-label="Close" className="shrink-0 text-muted hover:text-fg" onClick={() => dismiss(t.id)}>
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function App() {
  const ready = useApp((s) => s.ready);
  const route = useApp((s) => s.route);
  const onboarded = useApp((s) => s.settings.onboarded);
  const lang = useApp((s) => s.settings.uiLanguage);
  useTheme();

  useEffect(() => {
    useApp
      .getState()
      .init()
      .catch((e) => useApp.getState().toast(errorMessage(e), "error"));
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  // The macOS menu bar: Help > Manual and the app menu's Settings.
  useEffect(() => {
    const un = events.menu((id) => {
      const { go, settings } = useApp.getState();
      if (!settings.onboarded) return;
      if (id === "help") go({ name: "help" });
      else if (id === "settings") go({ name: "settings" });
    });
    return () => void un.then((f) => f());
  }, []);

  // The webview's own context menu and file-drop navigation make no sense in a desktop app.
  useEffect(() => {
    const prevent = (e: Event) => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  let screen;
  if (!ready) {
    screen = (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  } else if (!onboarded) {
    screen = <Welcome />;
  } else {
    switch (route.name) {
      case "home":
        screen = <Home />;
        break;
      case "setup":
        screen = <Setup key={route.id} projectId={route.id} />;
        break;
      case "progress":
        screen = <ProgressScreen key={route.id} projectId={route.id} />;
        break;
      case "editor":
        screen = <Editor key={`${route.id}:${route.at ?? ""}`} projectId={route.id} at={route.at} />;
        break;
      case "settings":
        screen = <SettingsScreen />;
        break;
      case "help":
        screen = <HelpScreen />;
        break;
    }
  }

  return (
    <TooltipProvider>
      <div className="h-full">{screen}</div>
      <Toasts />
    </TooltipProvider>
  );
}
