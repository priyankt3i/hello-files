module.exports = {
  content: [
    "./src/renderer/index.html",
    "./src/renderer/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: "#08111f",
        mist: "#cbd5e1",
        ember: "#ff7a18",
        pine: "#16324f",
        paper: "#f8fafc",
        coral: "#ff5f45",
        moss: "#7fb069"
      },
      fontFamily: {
        display: ["Georgia", "serif"],
        body: ["Segoe UI", "sans-serif"]
      },
      boxShadow: {
        panel: "0 18px 50px rgba(8, 17, 31, 0.18)"
      },
      backgroundImage: {
        "shell-gradient":
          "radial-gradient(circle at top left, rgba(255,122,24,0.18), transparent 32%), radial-gradient(circle at top right, rgba(22,50,79,0.22), transparent 28%), linear-gradient(135deg, #08111f 0%, #10233a 48%, #f4efe6 160%)"
      }
    }
  },
  plugins: []
};

