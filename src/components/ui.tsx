// Small UI kit. Everything visual in the app is built from these pieces so that the look
// stays consistent; colours come from the tokens in styles/app.css.

import clsx from "clsx";
import { Loader2, X } from "lucide-react";
import { Dialog as RDialog, DropdownMenu as RMenu, Slider as RSlider, Switch as RSwitch, Tooltip as RTooltip } from "radix-ui";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { forwardRef } from "react";

export const cx = clsx;

// ------------------------------------------------------------------ buttons

type Variant = "primary" | "secondary" | "ghost" | "danger" | "soft";
type Size = "sm" | "md" | "lg";

const variantClass: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover shadow-card",
  secondary: "bg-surface text-fg border border-line-strong hover:bg-surface-2 shadow-card",
  soft: "bg-accent-soft text-accent hover:brightness-95",
  ghost: "text-fg-2 hover:bg-surface-3 hover:text-fg",
  danger: "bg-danger text-white hover:brightness-95 shadow-card",
};
const sizeClass: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[13px] gap-1.5 rounded-md",
  md: "h-9 px-3.5 text-sm gap-2 rounded-lg",
  lg: "h-11 px-5 text-[15px] gap-2 rounded-xl",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        "inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-colors select-none",
        "disabled:opacity-50",
        variantClass[variant],
        sizeClass[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  size?: "sm" | "md";
  shortcut?: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active, size = "md", shortcut, className, children, ...rest },
  ref,
) {
  return (
    <Tooltip label={label} shortcut={shortcut}>
      <button
        ref={ref}
        aria-label={label}
        aria-pressed={active}
        className={cx(
          "inline-flex shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-40",
          size === "md" ? "size-9" : "size-7",
          active ? "bg-accent-soft text-accent" : "text-fg-2 hover:bg-surface-3 hover:text-fg",
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  );
});

// ------------------------------------------------------------------ tooltip

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <RTooltip.Provider delayDuration={350}>{children}</RTooltip.Provider>;
}

export function Tooltip({ label, shortcut, children }: { label: ReactNode; shortcut?: string; children: ReactNode }) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          sideOffset={6}
          className="anim-pop z-50 flex max-w-xs items-center gap-2 rounded-md bg-fg px-2 py-1 text-xs text-bg shadow-pop"
        >
          {label}
          {shortcut && <span className="rounded bg-white/20 px-1 font-mono text-[10px]">{shortcut}</span>}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-strong bg-surface-2 px-1 font-mono text-[11px] text-fg-2">
      {children}
    </kbd>
  );
}

// ------------------------------------------------------------------ dialog

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 480,
  dismissable = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
  dismissable?: boolean;
}) {
  return (
    <RDialog.Root open={open} onOpenChange={(o) => (dismissable || o) && onOpenChange(o)}>
      <RDialog.Portal>
        <RDialog.Overlay className="anim-fade fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
        <RDialog.Content
          style={{ width }}
          className="anim-pop fixed top-1/2 left-1/2 z-50 flex max-h-[88vh] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-line bg-surface shadow-modal"
        >
          <div className="flex items-start gap-3 px-6 pt-5 pb-2">
            <div className="min-w-0 flex-1">
              <RDialog.Title className="text-[17px] font-semibold tracking-tight">{title}</RDialog.Title>
              {description ? (
                <RDialog.Description className="mt-1 text-sm text-fg-2">{description}</RDialog.Description>
              ) : (
                <RDialog.Description className="sr-only">{title}</RDialog.Description>
              )}
            </div>
            {dismissable && (
              <RDialog.Close asChild>
                <button aria-label="Close" className="-mr-2 rounded-lg p-1.5 text-muted hover:bg-surface-3 hover:text-fg">
                  <X className="size-4" />
                </button>
              </RDialog.Close>
            )}
          </div>
          {children && <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">{children}</div>}
          {footer && <div className="flex items-center justify-end gap-2 px-6 pt-2 pb-5">{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

// ------------------------------------------------------------------ menu

export function Menu({ trigger, children, align = "end" }: { trigger: ReactNode; children: ReactNode; align?: "start" | "end" }) {
  return (
    <RMenu.Root>
      <RMenu.Trigger asChild>{trigger}</RMenu.Trigger>
      <RMenu.Portal>
        <RMenu.Content
          align={align}
          sideOffset={6}
          className="anim-pop z-50 min-w-44 rounded-xl border border-line bg-surface p-1 shadow-pop"
        >
          {children}
        </RMenu.Content>
      </RMenu.Portal>
    </RMenu.Root>
  );
}

export function MenuItem({
  children,
  icon,
  danger,
  onSelect,
  disabled,
  shortcut,
}: {
  children: ReactNode;
  icon?: ReactNode;
  danger?: boolean;
  onSelect?: () => void;
  disabled?: boolean;
  shortcut?: string;
}) {
  return (
    <RMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cx(
        "flex h-8 cursor-default items-center gap-2 rounded-lg px-2.5 text-sm outline-none select-none data-[disabled]:opacity-40",
        danger ? "text-danger data-[highlighted]:bg-danger-soft" : "text-fg data-[highlighted]:bg-surface-3",
      )}
    >
      {icon && <span className="flex size-4 items-center justify-center [&>svg]:size-4">{icon}</span>}
      <span className="flex-1">{children}</span>
      {shortcut && <span className="font-mono text-[11px] text-muted">{shortcut}</span>}
    </RMenu.Item>
  );
}

export function MenuSeparator() {
  return <RMenu.Separator className="my-1 h-px bg-line" />;
}

// ------------------------------------------------------------------ form controls

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <RSwitch.Root
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={label}
      className="relative h-5 w-9 shrink-0 rounded-full bg-line-strong transition-colors disabled:opacity-50 data-[state=checked]:bg-accent"
    >
      <RSwitch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
    </RSwitch.Root>
  );
}

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  label,
  className,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  label: string;
  className?: string;
}) {
  return (
    <RSlider.Root
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={(v) => onChange(v[0])}
      className={cx("relative flex h-5 touch-none items-center select-none", className)}
    >
      <RSlider.Track className="relative h-1 grow rounded-full bg-line-strong">
        <RSlider.Range className="absolute h-full rounded-full bg-accent" />
      </RSlider.Track>
      <RSlider.Thumb aria-label={label} className="block size-3.5 rounded-full border border-line-strong bg-white shadow" />
    </RSlider.Root>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput(
  { className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      spellCheck={false}
      className={cx(
        "h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-fg outline-none placeholder:text-muted",
        "focus:border-accent focus:ring-2 focus:ring-accent/20",
        className,
      )}
      {...rest}
    />
  );
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(
        "h-9 rounded-lg border border-line-strong bg-surface px-2.5 pr-7 text-sm text-fg outline-none",
        "focus:border-accent focus:ring-2 focus:ring-accent/20",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

/** A small set of mutually exclusive options shown side by side. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = "md",
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  size?: "sm" | "md";
}) {
  return (
    <div className="inline-flex rounded-lg bg-surface-3 p-0.5" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            "rounded-md px-3 font-medium transition-colors",
            size === "md" ? "h-8 text-sm" : "h-6 text-xs",
            o.value === value ? "bg-surface text-fg shadow-card" : "text-fg-2 hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("flex flex-col gap-1.5", className)}>
      <span className="text-[13px] font-medium text-fg">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

// ------------------------------------------------------------------ feedback

export function Progress({ value, className, tone = "accent" }: { value: number | null; className?: string; tone?: "accent" | "ok" }) {
  return (
    <div className={cx("h-1.5 overflow-hidden rounded-full bg-surface-3", className)} role="progressbar" aria-valuenow={value ?? undefined}>
      {value === null ? (
        <div className={cx("h-full w-1/3 animate-pulse rounded-full", tone === "ok" ? "bg-ok" : "bg-accent")} />
      ) : (
        <div
          className={cx("h-full rounded-full transition-[width] duration-300", tone === "ok" ? "bg-ok" : "bg-accent")}
          style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }}
        />
      )}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("size-4 animate-spin text-muted", className)} />;
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "ok" | "warn" | "danger" }) {
  const tones = {
    neutral: "bg-surface-3 text-fg-2",
    accent: "bg-accent-soft text-accent",
    ok: "bg-ok-soft text-ok",
    warn: "bg-warn-soft text-warn",
    danger: "bg-danger-soft text-danger",
  };
  return <span className={cx("inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium", tones[tone])}>{children}</span>;
}

export function Callout({ tone = "accent", icon, children }: { tone?: "accent" | "warn" | "danger" | "ok"; icon?: ReactNode; children: ReactNode }) {
  const tones = {
    accent: "bg-accent-soft text-fg",
    warn: "bg-warn-soft text-fg",
    danger: "bg-danger-soft text-fg",
    ok: "bg-ok-soft text-fg",
  };
  const iconTone = { accent: "text-accent", warn: "text-warn", danger: "text-danger", ok: "text-ok" };
  return (
    <div className={cx("flex gap-2.5 rounded-xl px-3.5 py-2.5 text-[13px] leading-relaxed", tones[tone])}>
      {icon && <span className={cx("mt-0.5 shrink-0 [&>svg]:size-4", iconTone[tone])}>{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
