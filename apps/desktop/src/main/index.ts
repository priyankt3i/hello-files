import type { BrowserWindow as ElectronBrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopAppService } from "./services/app-service";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
const { app, BrowserWindow, ipcMain, shell } = require("electron") as typeof import("electron");

const APP_ID = "com.hellofiles.desktop";
const APP_NAME = "Hello Files";
const DEV_ICON_PATH = join(__dirname, "../../build/hello-files-logo.ico");
const PACKAGED_ICON_PATH = join(process.resourcesPath, "hello-files-logo.ico");
const DEV_SPLASH_HTML_PATH = join(__dirname, "../../src/renderer/assets/splash.html");
const PACKAGED_SPLASH_HTML_PATH = join(process.resourcesPath, "splash/splash.html");

let mainWindow: ElectronBrowserWindow | null = null;
let splashWindow: ElectronBrowserWindow | null = null;
let service: DesktopAppService | null = null;
let rendererReady = false;

app.setName(APP_NAME);
if (process.platform === "win32") {
  app.setAppUserModelId(APP_ID);
}

async function createWindow() {
  rendererReady = false;
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    show: false,
    title: APP_NAME,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#08111f",
    icon: resolveWindowIcon(),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    closeSplashWindow();
  });

  service?.attachWebContents(mainWindow.webContents);

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  attachNavigationGuards(mainWindow);
}

app.whenReady().then(async () => {
  await createSplashWindow();
  service = new DesktopAppService();
  registerIpc();
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createSplashWindow();
      await createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

function registerIpc() {
  ipcMain.on("fschat:renderer-ready", revealMainWindow);
  ipcMain.handle("fschat:bootstrap", () => getService().bootstrap());
  ipcMain.handle("fschat:select-root-folder", () => getService().selectRootFolder());
  ipcMain.handle("fschat:inspect-root-folder", (_event, rootPath: string) => getService().inspectRootFolder(rootPath));
  ipcMain.handle("fschat:connect-provider", (_event, input) => getService().connectProvider(input));
  ipcMain.handle("fschat:reset-app-data", () => getService().resetAppData());
  ipcMain.handle("fschat:refresh-provider-models", (_event, connectionId: string) =>
    getService().refreshProviderModels(connectionId)
  );
  ipcMain.handle("fschat:save-provider-defaults", (_event, connectionId: string, chatModelId, embeddingModelId) =>
    getService().saveProviderDefaults(connectionId, chatModelId, embeddingModelId)
  );
  ipcMain.handle("fschat:register-channel", (_event, input) => getService().registerChannel(input));
  ipcMain.handle("fschat:update-channel-models", (_event, input) => getService().updateChannelModels(input));
  ipcMain.handle("fschat:update-channel-system-prompt", (_event, input) => getService().updateChannelSystemPrompt(input));
  ipcMain.handle("fschat:delete-channel", (_event, input) => getService().deleteChannel(input));
  ipcMain.handle("fschat:load-channel", (_event, channelId: string) => getService().loadChannel(channelId));
  ipcMain.handle("fschat:start-index", (_event, channelId: string) => getService().startIndex(channelId));
  ipcMain.handle("fschat:regenerate-index", (_event, channelId: string) => getService().regenerateIndex(channelId));
  ipcMain.handle("fschat:cancel-index", (_event, input) => getService().cancelIndex(input));
  ipcMain.handle("fschat:list-channel-files", (_event, channelId: string, status) => getService().listChannelFiles(channelId, status));
  ipcMain.handle("fschat:create-thread", (_event, input) => getService().createThread(input));
  ipcMain.handle("fschat:update-thread-title", (_event, input) => getService().updateThreadTitle(input));
  ipcMain.handle("fschat:delete-thread", (_event, threadId: string) => getService().deleteThread(threadId));
  ipcMain.handle("fschat:open-channel-file", (_event, input) => getService().openChannelFile(input));
  ipcMain.handle("fschat:reveal-channel-file", (_event, input) => getService().revealChannelFile(input));
  ipcMain.handle("fschat:get-thread-messages", (_event, threadId: string) => getService().getThreadMessages(threadId));
  ipcMain.handle("fschat:send-message", (_event, input) => getService().sendMessage(input));
  ipcMain.handle("fschat:open-external-url", (_event, url: string) => openExternalUrl(url));
}

async function createSplashWindow() {
  closeSplashWindow();
  splashWindow = new BrowserWindow({
    width: 560,
    height: 520,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: "#f7f7f5",
    icon: resolveWindowIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  splashWindow.once("ready-to-show", () => {
    if (!rendererReady && splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.show();
    }
  });
  splashWindow.on("closed", () => {
    splashWindow = null;
  });

  const splashHtmlPath = resolveSplashHtmlPath();
  if (splashHtmlPath) {
    await splashWindow.loadFile(splashHtmlPath);
  } else {
    await splashWindow.loadURL(buildSplashFallbackHtmlUrl());
  }
}

function revealMainWindow() {
  rendererReady = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
  closeSplashWindow();
}

function closeSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
  }
  splashWindow = null;
}

function buildSplashFallbackHtmlUrl() {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${APP_NAME}</title>
    <style>
      * { box-sizing: border-box; }
      html, body { height: 100%; margin: 0; overflow: hidden; }
      body {
        -webkit-app-region: drag;
        align-items: center;
        background: #f7f7f5;
        color: #2b2b28;
        display: flex;
        font-family: "Inter", "Segoe UI", system-ui, sans-serif;
        justify-content: center;
      }
      main {
        align-items: center;
        display: flex;
        flex-direction: column;
        gap: 22px;
        height: 100%;
        justify-content: center;
        padding: 34px;
        width: 100%;
      }
      .splash-fallback {
        font-size: 42px;
        font-weight: 700;
      }
      .progress {
        background: rgba(255, 255, 255, 0.62);
        border: 3px solid #2b2b28;
        height: 30px;
        overflow: hidden;
        position: relative;
        width: min(300px, 68vw);
      }
      .progress-fill {
        animation: progress 1.8s ease-in-out infinite;
        background: #08a9dc;
        bottom: 0;
        left: 0;
        position: absolute;
        top: 0;
        width: 62%;
      }
      .progress-label {
        color: #0f172a;
        font-size: 13px;
        font-weight: 700;
        inset: 0;
        line-height: 24px;
        position: absolute;
        text-align: center;
      }
      @keyframes progress {
        0% { transform: translateX(-70%); }
        55% { transform: translateX(38%); }
        100% { transform: translateX(112%); }
      }
    </style>
  </head>
  <body>
    <main aria-label="${APP_NAME} is loading">
      <div class="splash-fallback">Hello Files</div>
      <div class="progress" role="status" aria-label="Loading chats">
        <div class="progress-fill" aria-hidden="true"></div>
        <div class="progress-label">Loading Chats...</div>
      </div>
    </main>
  </body>
</html>`;
  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`;
}

function resolveSplashHtmlPath() {
  const splashHtmlPath = app.isPackaged ? PACKAGED_SPLASH_HTML_PATH : DEV_SPLASH_HTML_PATH;
  return existsSync(splashHtmlPath) ? splashHtmlPath : null;
}

function getService() {
  if (!service) {
    throw new Error("Desktop service is not initialized yet.");
  }
  return service;
}

function attachNavigationGuards(window: ElectronBrowserWindow) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    const currentUrl = window.webContents.getURL();
    if (isSameDocumentNavigation(currentUrl, url)) {
      return;
    }
    event.preventDefault();
    void openExternalUrl(url);
  });
}

function resolveWindowIcon() {
  const iconPath = app.isPackaged ? PACKAGED_ICON_PATH : DEV_ICON_PATH;
  return existsSync(iconPath) ? iconPath : undefined;
}

async function openExternalUrl(url: string) {
  const safeUrl = normalizeExternalUrl(url);
  await shell.openExternal(safeUrl);
}

function normalizeExternalUrl(url: string) {
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("A valid external URL is required.");
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Only fully qualified http(s) URLs can be opened.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http(s) URLs can be opened.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("External URLs with embedded credentials are not allowed.");
  }

  return parsed.toString();
}

function isSameDocumentNavigation(currentUrl: string, nextUrl: string) {
  if (!currentUrl || currentUrl === nextUrl) {
    return true;
  }

  try {
    const current = new URL(currentUrl);
    const next = new URL(nextUrl);
    return (
      current.protocol === next.protocol &&
      current.host === next.host &&
      current.pathname === next.pathname &&
      current.search === next.search
    );
  } catch {
    return false;
  }
}
