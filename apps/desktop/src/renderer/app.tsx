import { FolderPlus, KeyRound, Lock, MessageSquareText } from "lucide-react";
import type { Channel } from "@fschat/shared";
import helloFilesLogo from "./assets/hello-files-logo.png";
import { AppSettingsDialog } from "./components/app-settings/app-settings-dialog";
import { ChatView } from "./components/chat/chat-view";
import { FilesView } from "./components/files/files-view";
import { KnowledgeBaseAlerts, KnowledgeBaseHeader } from "./components/kb-header";
import { KbSettingsView } from "./components/kb-settings/kb-settings-view";
import { NewKnowledgeBaseDialog } from "./components/new-kb-dialog";
import { Sidebar } from "./components/sidebar";
import { ToastViewport } from "./components/toasts";
import { Button } from "./components/ui/button";
import { useTheme } from "./lib/theme";
import { AppStoreProvider, useAppStore } from "./state/store";
import { ToastProvider } from "./state/toasts";

export function App() {
  return (
    <ToastProvider>
      <AppStoreProvider>
        <Shell />
        <ToastViewport />
      </AppStoreProvider>
    </ToastProvider>
  );
}

function Shell() {
  const { state, selectedChannel } = useAppStore();
  const [theme, setTheme] = useTheme();

  if (!state.ready) {
    return <SplashScreen />;
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-bg text-text">
      <Sidebar />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selectedChannel ? <KnowledgeBaseView channel={selectedChannel} /> : <WelcomeView />}
      </main>
      {state.newKbOpen ? <NewKnowledgeBaseDialog /> : null}
      {state.appSettingsSection ? (
        <AppSettingsDialog section={state.appSettingsSection} theme={theme} onThemeChange={setTheme} />
      ) : null}
    </div>
  );
}

function KnowledgeBaseView({ channel }: { channel: Channel }) {
  const { state } = useAppStore();
  return (
    <>
      <KnowledgeBaseHeader channel={channel} />
      {state.tab !== "settings" ? <KnowledgeBaseAlerts channel={channel} /> : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" role="tabpanel">
        {state.tab === "chat" ? <ChatView channel={channel} /> : null}
        {state.tab === "files" ? <FilesView channel={channel} /> : null}
        {state.tab === "settings" ? <KbSettingsView channel={channel} /> : null}
      </div>
    </>
  );
}

function WelcomeView() {
  const { state, actions } = useAppStore();
  const hasProviders = state.models.some((model) => model.supportsChat);
  const steps = [
    {
      icon: KeyRound,
      title: "Connect an AI provider",
      body: "Use your organisation's Azure OpenAI, another cloud provider, or Ollama to keep everything on this computer.",
      done: hasProviders,
      action: (
        <Button size="sm" variant={hasProviders ? "secondary" : "primary"} onClick={() => actions.openAppSettings("providers")}>
          {hasProviders ? "Manage providers" : "Connect provider"}
        </Button>
      )
    },
    {
      icon: FolderPlus,
      title: "Create a knowledge base",
      body: "Pick a folder of documents. Hello Files reads them without changing anything.",
      done: false,
      action: (
        <Button size="sm" variant={hasProviders ? "primary" : "secondary"} onClick={actions.openNewKb}>
          New knowledge base
        </Button>
      )
    },
    {
      icon: MessageSquareText,
      title: "Ask questions",
      body: "Get answers with numbered sources you can open and check.",
      done: false,
      action: null
    }
  ];

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-8">
      <div className="w-full max-w-xl">
        <img src={helloFilesLogo} alt="" className="mb-4 h-12 w-12 object-contain" />
        <h1 className="text-xl font-semibold text-text">Welcome to Hello Files</h1>
        <p className="mt-1 text-sm text-text-muted">Ask questions about the documents in your folders and get answers with sources.</p>
        <ol className="mt-6 space-y-3">
          {steps.map((step, index) => (
            <li key={step.title} className="flex items-start gap-3 rounded-md border border-border bg-surface p-4 shadow-card">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
                <step.icon className="h-4 w-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-text">
                  {index + 1}. {step.title}
                  {step.done ? <span className="ml-2 text-xs font-normal text-success">Done</span> : null}
                </div>
                <div className="mt-0.5 text-xs leading-relaxed text-text-muted">{step.body}</div>
              </div>
              {step.action}
            </li>
          ))}
        </ol>
        {state.settings.dataPolicy === "local-only" ? (
          <p className="mt-4 flex items-center gap-1.5 text-xs text-text-muted">
            <Lock className="h-3.5 w-3.5 text-success" aria-hidden />
            Local-only mode is on: only models on this computer can be used.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function SplashScreen() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 bg-bg text-text" role="status" aria-live="polite">
      <img src={helloFilesLogo} alt="" className="h-14 w-14 object-contain" />
      <div className="text-base font-semibold">Hello Files</div>
      <div className="relative h-1 w-48 overflow-hidden rounded-full bg-surface-2">
        <div className="progress-indeterminate absolute inset-y-0 left-0 w-2/5 rounded-full bg-accent" />
      </div>
      <div className="text-xs text-text-muted">Loading your knowledge bases…</div>
    </div>
  );
}
