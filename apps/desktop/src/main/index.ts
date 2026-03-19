import type { BrowserWindow as ElectronBrowserWindow } from "electron";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopAppService } from "./services/app-service";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
const { app, BrowserWindow, ipcMain } = require("electron") as typeof import("electron");

let mainWindow: ElectronBrowserWindow | null = null;
let service: DesktopAppService | null = null;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#08111f",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  service?.attachWebContents(mainWindow.webContents);

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  service = new DesktopAppService();
  registerIpc();
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
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
  ipcMain.handle("fschat:delete-channel", (_event, channelId: string) => getService().deleteChannel(channelId));
  ipcMain.handle("fschat:load-channel", (_event, channelId: string) => getService().loadChannel(channelId));
  ipcMain.handle("fschat:start-index", (_event, channelId: string) => getService().startIndex(channelId));
  ipcMain.handle("fschat:regenerate-index", (_event, channelId: string) => getService().regenerateIndex(channelId));
  ipcMain.handle("fschat:cancel-index", (_event, input) => getService().cancelIndex(input));
  ipcMain.handle("fschat:list-channel-files", (_event, channelId: string, status) => getService().listChannelFiles(channelId, status));
  ipcMain.handle("fschat:get-thread-messages", (_event, threadId: string) => getService().getThreadMessages(threadId));
  ipcMain.handle("fschat:send-message", (_event, input) => getService().sendMessage(input));
}

function getService() {
  if (!service) {
    throw new Error("Desktop service is not initialized yet.");
  }
  return service;
}
