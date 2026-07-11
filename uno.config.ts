import { defineConfig, presetIcons, presetWind } from "unocss";

export default defineConfig({
  presets: [
    presetWind({
      preflight: false,
    }),
    presetIcons({
      scale: 1.2,
      extraProperties: {
        "display": "inline-block",
        "vertical-align": "middle",
      },
    }),
  ],
  theme: {
    colors: {
      primary: "rgb(var(--color-primary) / <alpha-value>)",
      secondary: "rgb(var(--color-secondary) / <alpha-value>)",
      accent: "rgb(var(--color-accent) / <alpha-value>)",
      text: {
        DEFAULT: "rgb(var(--color-text) / <alpha-value>)",
        secondary: "rgb(var(--color-text) / 70%)",
      },
      muted: "rgb(var(--color-muted) / <alpha-value>)",
      border: "rgb(var(--color-border) / 15%)",
      "focused-border": "rgb(var(--color-focused-border) / <alpha-value>)",
      background: "rgb(var(--color-background) / <alpha-value>)",
      surface: {
        DEFAULT: "rgb(var(--color-surface) / <alpha-value>)",
        hover: "rgb(var(--color-primary) / 80%)",
      },
      overlay: "rgb(var(--color-background) / 85%)",
      "selected-bg": "rgb(var(--color-selected-bg) / <alpha-value>)",
      "selected-text": "rgb(var(--color-selected-text) / <alpha-value>)",
      "on-solid": "rgb(var(--color-on-solid) / <alpha-value>)",
      success: "rgb(var(--color-success) / <alpha-value>)",
      error: "rgb(var(--color-error) / <alpha-value>)",
      warning: "rgb(var(--color-warning) / <alpha-value>)",
      info: "rgb(var(--color-info) / <alpha-value>)",
    },
    fontFamily: {
      sans: '"Inter", ui-sans-serif, system-ui, -apple-system, blinkmacsystemfont, "Segoe UI", roboto, sans-serif',
      mono: '"JetBrains Mono", "Fira Code", ui-monospace, sfmono-regular, monospace',
    },
    fontSize: {
      "2xs": "var(--text-2xs)",
      xs: "var(--text-xs)",
      sm: "var(--text-sm)",
      base: "var(--text-base)",
      md: "var(--text-md)",
      lg: "var(--text-lg)",
      xl: "var(--text-xl)",
      "2xl": "var(--text-2xl)",
    },
    borderRadius: {
      DEFAULT: "10px",
      full: "var(--radius-full)",
    },
  },
  shortcuts: {
    "ring-color": "ring-2 ring-primary ring-offset-2",
  },
  preflights: [
    {
      getCSS: () => `
        [data-mode="dark"] * { --un-dark: ; }
      `,
    },
  ],
});
