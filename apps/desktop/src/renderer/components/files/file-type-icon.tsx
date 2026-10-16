import { File, FileImage, FileSpreadsheet, FileText, Presentation } from "lucide-react";
import { cx, fileKind } from "../../lib/format";

const ICONS = {
  pdf: { icon: FileText, color: "text-danger" },
  doc: { icon: FileText, color: "text-accent" },
  sheet: { icon: FileSpreadsheet, color: "text-success" },
  slides: { icon: Presentation, color: "text-warning" },
  image: { icon: FileImage, color: "text-text-muted" },
  text: { icon: FileText, color: "text-text-muted" },
  other: { icon: File, color: "text-text-muted" }
};

export function FileTypeIcon({ path, className }: { path: string; className?: string }) {
  const { icon: Icon, color } = ICONS[fileKind(path)];
  return <Icon className={cx("h-4 w-4 shrink-0", color, className)} aria-hidden />;
}
