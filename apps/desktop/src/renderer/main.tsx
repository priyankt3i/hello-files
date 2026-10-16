import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app";
import { applyTheme, readStoredTheme } from "./lib/theme";
import "./styles/index.css";

// Apply the saved theme before the first paint to avoid a light/dark flash.
applyTheme(readStoredTheme());

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

// window.fsChat is injected by the Electron preload. It is missing when the dev server URL is
// opened in a normal browser, or when the preload failed to load.
if (typeof window.fsChat === "undefined") {
  root.render(<MissingDesktopBridge />);
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

function MissingDesktopBridge() {
  return (
    <div className="flex h-screen items-center justify-center bg-bg p-8 text-text">
      <div className="max-w-md space-y-3 rounded-lg border border-border bg-surface p-6 text-sm">
        <h1 className="text-base font-semibold">Hello Files must run in its desktop window</h1>
        <p className="text-text-muted">
          This page was opened without the desktop bridge. If you opened the development URL in a web browser, close it and use the
          Hello Files window that <code>npm run dev</code> opens instead.
        </p>
        <p className="text-text-muted">
          If you are already in the Hello Files window, the preload script failed to load. Check the terminal running{" "}
          <code>npm run dev</code> for an "Unable to load preload script" error.
        </p>
      </div>
    </div>
  );
}
