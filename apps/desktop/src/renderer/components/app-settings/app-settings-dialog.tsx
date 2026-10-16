import { HardDrive, KeyRound, Palette, ShieldCheck, type LucideIcon } from "lucide-react";
import { cx } from "../../lib/format";
import type { ThemeMode } from "../../lib/theme";
import { useAppStore } from "../../state/store";
import type { AppSettingsSection } from "../../state/types";
import { Modal } from "../ui/modal";
import { AppearanceSection, PrivacySection, StorageSection } from "./general-sections";
import { ProvidersSection } from "./providers-section";

const NAV: Array<{ id: AppSettingsSection; label: string; icon: LucideIcon }> = [
  { id: "providers", label: "Providers", icon: KeyRound },
  { id: "privacy", label: "Privacy", icon: ShieldCheck },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "storage", label: "Storage", icon: HardDrive }
];

export function AppSettingsDialog({
  section,
  theme,
  onThemeChange
}: {
  section: AppSettingsSection;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
}) {
  const { actions } = useAppStore();

  return (
    <Modal title="Settings" onClose={actions.closeAppSettings} size="xl" bodyClassName="flex">
      <div className="flex h-[min(680px,calc(100vh-10rem))] min-h-0 w-full">
        <nav aria-label="Settings sections" className="w-48 shrink-0 space-y-0.5 border-r border-border bg-surface-2/50 p-2">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={section === item.id ? "page" : undefined}
              onClick={() => actions.openAppSettings(item.id)}
              className={cx(
                "flex h-8 w-full items-center gap-2 rounded px-2.5 text-left text-sm transition-colors",
                section === item.id ? "bg-surface font-medium text-text shadow-card" : "text-text-muted hover:bg-surface hover:text-text"
              )}
            >
              <item.icon className="h-4 w-4 shrink-0" aria-hidden />
              {item.label}
            </button>
          ))}
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-6">
          {section === "providers" ? <ProvidersSection /> : null}
          {section === "privacy" ? <PrivacySection /> : null}
          {section === "appearance" ? <AppearanceSection theme={theme} onThemeChange={onThemeChange} /> : null}
          {section === "storage" ? <StorageSection /> : null}
        </div>
      </div>
    </Modal>
  );
}
