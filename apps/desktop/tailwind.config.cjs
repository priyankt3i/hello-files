module.exports = {
  content: [
    "./src/renderer/index.html",
    "./src/renderer/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        black: "rgb(var(--color-layer-dark) / <alpha-value>)",
        white: "rgb(var(--color-layer-light) / <alpha-value>)",
        ink: "rgb(var(--color-ink) / <alpha-value>)",
        mist: "rgb(var(--color-mist) / <alpha-value>)",
        ember: "rgb(var(--color-ember) / <alpha-value>)",
        pine: "rgb(var(--color-pine) / <alpha-value>)",
        paper: "rgb(var(--color-paper) / <alpha-value>)",
        coral: "rgb(var(--color-coral) / <alpha-value>)",
        moss: "rgb(var(--color-moss) / <alpha-value>)"
      },
      fontFamily: {
        display: ["Inter", "Segoe UI", "system-ui", "sans-serif"],
        body: ["Inter", "Segoe UI", "system-ui", "sans-serif"]
      },
      boxShadow: {
        panel: "var(--shadow-panel)"
      },
      backgroundImage: {
        "shell-gradient": "var(--background-shell)"
      },
      opacity: {
        6: "0.06",
        7: "0.07",
        8: "0.08",
        12: "0.12"
      }
    }
  },
  plugins: []
};
