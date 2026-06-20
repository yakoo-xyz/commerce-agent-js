import type { WidgetTheme } from "./types.js";

export type ResolvedThemeMode = "light" | "dark";

interface ThemePalette {
  backgroundColor: string;
  textColor: string;
  borderColor: string;
  mutedTextColor: string;
  surfaceColor: string;
  elevatedSurfaceColor: string;
  inputBackgroundColor: string;
  inputBorderColor: string;
  mediaBackgroundColor: string;
  settingsBackgroundColor: string;
  shadowColor: string;
  primaryGlow: string;
}

const LIGHT_PALETTE: ThemePalette = {
  backgroundColor: "#ffffff",
  textColor: "#1e293b",
  borderColor: "#e2e8f0",
  mutedTextColor: "#64748b",
  surfaceColor: "#f1f5f9",
  elevatedSurfaceColor: "#ffffff",
  inputBackgroundColor: "#ffffff",
  inputBorderColor: "#cbd5e1",
  mediaBackgroundColor: "#f1f5f9",
  settingsBackgroundColor: "#f8fafc",
  shadowColor: "rgba(15, 23, 42, 0.15)",
  primaryGlow: "rgba(99, 102, 241, 0.12)",
};

const DARK_PALETTE: ThemePalette = {
  backgroundColor: "#0a0f0c",
  textColor: "#f0f4f1",
  borderColor: "rgba(255, 255, 255, 0.1)",
  mutedTextColor: "rgba(240, 244, 241, 0.55)",
  surfaceColor: "rgba(255, 255, 255, 0.06)",
  elevatedSurfaceColor: "#141a16",
  inputBackgroundColor: "#050806",
  inputBorderColor: "rgba(255, 255, 255, 0.14)",
  mediaBackgroundColor: "#141a16",
  settingsBackgroundColor: "rgba(255, 255, 255, 0.03)",
  shadowColor: "rgba(0, 0, 0, 0.45)",
  primaryGlow: "rgba(255, 145, 56, 0.18)",
};

function parseHexColor(color: string): { r: number; g: number; b: number } | null {
  const hex = color.trim();
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!match) return null;
  let value = match[1];
  if (value.length === 3) {
    value = value
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const num = Number.parseInt(value, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

function relativeLuminance(r: number, g: number, b: number): number {
  const toLinear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastTextOn(color: string): string {
  const rgb = parseHexColor(color);
  if (!rgb) return "#ffffff";
  return relativeLuminance(rgb.r, rgb.g, rgb.b) > 0.45 ? "#0a0f0c" : "#ffffff";
}

function primaryGlowFromColor(color: string, mode: ResolvedThemeMode): string {
  const rgb = parseHexColor(color);
  if (!rgb) return mode === "dark" ? DARK_PALETTE.primaryGlow : LIGHT_PALETTE.primaryGlow;
  const alpha = mode === "dark" ? 0.18 : 0.12;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

export function detectThemeMode(theme: WidgetTheme = {}): ResolvedThemeMode {
  if (theme.mode === "light" || theme.mode === "dark") return theme.mode;

  if (typeof document !== "undefined") {
    const dataTheme = document.documentElement.getAttribute("data-theme");
    if (dataTheme === "light" || dataTheme === "dark") return dataTheme;
  }

  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  return "light";
}

export function resolveWidgetTheme(theme: WidgetTheme = {}): Record<string, string> {
  const mode = detectThemeMode(theme);
  const palette = mode === "dark" ? DARK_PALETTE : LIGHT_PALETTE;

  const primary = theme.primaryColor ?? (mode === "dark" ? "#ff9138" : "#6366f1");
  const bg = theme.backgroundColor ?? palette.backgroundColor;
  const text = theme.textColor ?? palette.textColor;
  const border = theme.borderColor ?? palette.borderColor;
  const muted = theme.mutedTextColor ?? palette.mutedTextColor;
  const surface = theme.surfaceColor ?? palette.surfaceColor;
  const elevated = theme.elevatedSurfaceColor ?? palette.elevatedSurfaceColor;
  const inputBg = theme.inputBackgroundColor ?? palette.inputBackgroundColor;
  const inputBorder = theme.inputBorderColor ?? palette.inputBorderColor;
  const mediaBg = theme.mediaBackgroundColor ?? palette.mediaBackgroundColor;
  const settingsBg = theme.settingsBackgroundColor ?? palette.settingsBackgroundColor;
  const radius = theme.borderRadius ?? "12px";
  const font = theme.fontFamily ?? "system-ui, -apple-system, sans-serif";
  const z = String(theme.zIndex ?? 99999);
  const position = theme.position ?? "bottom-right";

  return {
    "--ca-primary": primary,
    "--ca-on-primary": contrastTextOn(primary),
    "--ca-bg": bg,
    "--ca-text": text,
    "--ca-text-muted": muted,
    "--ca-border": border,
    "--ca-surface": surface,
    "--ca-surface-elevated": elevated,
    "--ca-input-bg": inputBg,
    "--ca-input-border": inputBorder,
    "--ca-media-bg": mediaBg,
    "--ca-settings-bg": settingsBg,
    "--ca-shadow": palette.shadowColor,
    "--ca-primary-glow": primaryGlowFromColor(primary, mode),
    "--ca-radius": radius,
    "--ca-font": font,
    "--ca-z": z,
    "--ca-color-scheme": mode,
    "--ca-pos-left": position === "bottom-left" ? "24px" : "auto",
    "--ca-pos-right": position === "bottom-right" ? "24px" : "auto",
  };
}

export function applyThemeToElement(el: HTMLElement, vars: Record<string, string>): void {
  for (const [key, value] of Object.entries(vars)) {
    el.style.setProperty(key, value);
  }
}

export function watchThemeChanges(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => undefined;
  }

  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "class"],
  });

  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onMediaChange = () => onChange();
  media.addEventListener("change", onMediaChange);

  return () => {
    observer.disconnect();
    media.removeEventListener("change", onMediaChange);
  };
}
