import type { IndexedDocumentRecord, SearchResult } from "@fschat/shared";

export function tokenizeManifestQuery(query: string): string[] {
  return query.toLowerCase().match(/[a-z0-9]+/g)?.filter((token) => token.length > 1) ?? [];
}

export function isVisualInventoryQuery(query: string): boolean {
  return /\b(image|images|photo|photos|picture|pictures|chart|charts|graph|graphs|diagram|diagrams|figure|figures|screenshot|screenshots|visual|visuals)\b/i.test(query);
}

export function preselectManifestDocuments(
  documents: IndexedDocumentRecord[],
  query: string,
  limit: number
): IndexedDocumentRecord[] {
  const queryTokens = tokenizeManifestQuery(query);
  return [...documents]
    .sort((left, right) => {
      const leftScore = scoreManifestDocument(left, query, queryTokens);
      const rightScore = scoreManifestDocument(right, query, queryTokens);
      return rightScore - leftScore;
    })
    .slice(0, limit);
}

export function resolveSelectedDocumentIds(
  documentIds: string[],
  documents: IndexedDocumentRecord[]
): string[] {
  const validIds = new Set(documents.map((document) => document.documentId));
  return documentIds.filter((documentId) => validIds.has(documentId));
}

export function scoreManifestDocument(
  document: IndexedDocumentRecord,
  query: string,
  queryTokens: string[]
): number {
  const structureHints =
    document.structure?.kind === "spreadsheet"
      ? [...document.structure.sheetNames, ...document.structure.columnHints]
      : [];
  const visualHints = [
    ...(document.visualAssetSummary?.labels ?? []),
    ...Object.keys(document.visualAssetSummary?.byKind ?? {}),
    ...((document.visualAssets ?? []).map((asset) => asset.label))
  ];
  const haystack = [document.relativePath, document.summary, ...document.sectionHints, ...structureHints, ...visualHints].join(" ").toLowerCase();
  const lowerQuery = query.toLowerCase().trim();
  let score = 0;
  if (lowerQuery && haystack.includes(lowerQuery)) {
    score += 5;
  }
  for (const token of new Set(queryTokens)) {
    const count = haystack.split(token).length - 1;
    if (count > 0) {
      score += Math.min(count, 6);
    }
    if (document.relativePath.toLowerCase().includes(token)) {
      score += 1.5;
    }
  }
  if ((document.visualAssetSummary?.total ?? 0) > 0 && isVisualInventoryQuery(query)) {
    score += 4;
  }
  return score;
}

export function summarizeVisualInventoryNotes(documents: IndexedDocumentRecord[]): string[] {
  const documentsWithVisuals = documents.filter((document) => (document.visualAssetSummary?.total ?? 0) > 0);
  if (documentsWithVisuals.length === 0) {
    return [
      "Indexed visual inventory does not record embedded raster images for the selected documents. Vector-drawn charts or table-like layouts may still exist but are not confirmed by image metadata."
    ];
  }

  const notes = [
    "Indexed visual inventory is based on stored metadata for PDF pages/images, DOCX media, and standalone image files. It does not fully detect vector-drawn charts."
  ];
  for (const document of documentsWithVisuals.slice(0, 8)) {
    const summary = document.visualAssetSummary;
    if (!summary) {
      continue;
    }
    const kindSummary = Object.entries(summary.byKind ?? {})
      .map(([kind, count]) => `${count} ${kind}`)
      .join(", ");
    const pageNumbers = summary.pages ?? [];
    const assetLabels = summary.labels ?? [];
    const pages = pageNumbers.length > 0 ? ` Pages: ${pageNumbers.slice(0, 12).join(", ")}.` : "";
    const labels = assetLabels.length > 0 ? ` Samples: ${assetLabels.slice(0, 5).join(" | ")}.` : "";
    notes.push(`${document.relativePath}: ${summary.total} indexed visual asset(s)${kindSummary ? ` (${kindSummary})` : ""}.${pages}${labels}`);
  }
  if (documentsWithVisuals.length > 8) {
    notes.push(`${documentsWithVisuals.length - 8} additional document(s) also contain indexed visual assets.`);
  }
  return notes;
}