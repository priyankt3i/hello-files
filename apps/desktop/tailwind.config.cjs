/** Semantic design tokens. Values live in src/renderer/styles/index.css (light + dark). */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

module.exports = {
  darkMode: ["selector", '[data-theme="dark"]'],
  content: ["./src/renderer/index.html", "./src/renderer/**/*.{ts,tsx}"],
  theme: {
    // Radii are restricted on purpose: 6px (controls), 8px (cards), 12px (dialogs).
    borderRadius: {
      none: "0",
      sm: "4px",
      DEFAULT: "6px",
      md: "8px",
      lg: "12px",
      full: "9999px"
    },
    extend: {
      colors: {
        bg: token("bg"),
        surface: token("surface"),
        "surface-2": token("surface-2"),
        border: token("border"),
        text: token("text"),
        "text-muted": token("text-muted"),
        accent: token("accent"),
        "accent-fg": token("accent-fg"),
        success: token("success"),
        warning: token("warning"),
        danger: token("danger")
      },
      fontFamily: {
        sans: ['"Segoe UI Variable Text"', '"Segoe UI Variable"', '"Segoe UI"', "Inter", "system-ui", "-apple-system", "sans-serif"],
        mono: ['"Cascadia Code"', "Consolas", "ui-monospace", "monospace"]
      },
      fontSize: {
        "2xs": ["11px", "16px"]
      },
      boxShadow: {
        card: "var(--shadow-card)",
        popover: "var(--shadow-popover)",
        dialog: "var(--shadow-dialog)"
      }
    }
  },
  plugins: []
};
