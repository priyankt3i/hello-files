import type { IndexedDocumentRecord, SearchResult } from "@fschat/shared";
import { tokenizeManifestQuery } from "./retrieval-helpers";
import { detectAnalyticalIntent, isTabularDocumentPath } from "./spreadsheet-sql";

export function isSpreadsheetDocument(document: IndexedDocumentRecord): boolean {
  return document.structure?.kind === "spreadsheet" || document.parser === "spreadsheet" || document.parser === "spreadsheet-xls";
}

/** Spreadsheets and CSVs: everything the worker can load as exact tables (a superset of isSpreadsheetDocument). */
export function isTabularDocument(document: IndexedDocumentRecord): boolean {
  return isSpreadsheetDocument(document) || isTabularDocumentPath(document.relativePath, document.parser);
}

export function analyzeSpreadsheetQuery(query: string) {
  const normalized = query.toLowerCase();
  const wantsCount = /\b(count|how many|number of|total)\b/.test(normalized);
  const wantsList = /\b(list|show all|find all|which rows|which entries)\b/.test(normalized);
  const wantsFilter = /\b(rows where|entries where|matching rows|matching entries|filter|filtered)\b/.test(normalized);
  const exhaustive = wantsCount || wantsList;
  // "analytical" questions (totals, averages, groups, trends, charts) are answered by an exact SQL calculation.
  const analytical = detectAnalyticalIntent(query).analytical;
  return {
    wantsCount,
    wantsList,
    wantsFilter,
    exhaustive,
    analytical,
    plainRowCount: wantsCount && !wantsFilter && isPlainRowCountQuery(normalized)
  };
}

/**
 * True only for unconditioned size questions ("how many rows are in the claims sheet?").
 * Anything with a condition ("how many rows where status is open") must go to the model,
 * because sheet row totals cannot answer filtered counts.
 */
export function isPlainRowCountQuery(query: string): boolean {
  const normalized = query.toLowerCase();
  if (!/\b(rows?|records?|entries|lines)\b/.test(normalized)) {
    return false;
  }
  // Grouped, distinct or time-bucketed counts are calculations, not the sheet's size.
  if (/\b(per|by|each|group|grouped|break ?down|distinct|unique|average|avg|sum|trend|over time|monthly|quarterly|weekly|yearly|daily|chart|plot)\b/.test(normalized)) {
    return false;
  }
  return !/\b(where|with|whose|that|which|having|has|have|contain|contains|containing|equal|equals|greater|less|more than|fewer|above|below|after|before|between|over|under|exceed|exceeds|is|are not|status|named|called|marked)\b|[<>=]/.test(
    normalized.replace(/\bhow many (rows?|records?|entries|lines) (are|is) (there )?(in|on)\b/, "")
  );
}

export function summarizeSpreadsheetSearch(
  results: SearchResult[],
  documents: IndexedDocumentRecord[],
  queryProfile: ReturnType<typeof analyzeSpreadsheetQuery>
) {
  const rowResults = results.filter((item) => item.chunkType === "spreadsheet-row");
  if (rowResults.length === 0) {
    return null;
  }

  const sheetNames = [...new Set(rowResults.map((item) => item.sheetName).filter((item): item is string => Boolean(item)))];
  const notes: string[] = [];
  if (queryProfile.wantsCount) {
    notes.push(
      `Exact lexical row scan across ${documents.length} selected spreadsheet document(s) found ${rowResults.length} matching rows.` +
        (sheetNames.length > 0 ? ` Matching sheets: ${sheetNames.slice(0, 6).join(", ")}.` : "")
    );
  } else if (queryProfile.wantsList || queryProfile.wantsFilter) {
    notes.push(
      `Lexical row scan found ${rowResults.length} matching rows across ${documents.length} selected spreadsheet document(s). Showing the most relevant matches below.` +
        (sheetNames.length > 0 ? ` Matching sheets: ${sheetNames.slice(0, 6).join(", ")}.` : "")
    );
  }

  return {
    notes,
    sampleResults: rowResults.slice(0, 24)
  };
}

export function summarizeSpreadsheetStructureQuery(
  documents: IndexedDocumentRecord[],
  query: string,
  queryProfile: ReturnType<typeof analyzeSpreadsheetQuery>
) {
  const notes: string[] = [];
  const queryTokens = tokenizeManifestQuery(query);
  const matchedSheets: Array<{ document: IndexedDocumentRecord; name: string; rowCount: number; score: number }> = [];
  const fallbackSheets: Array<{ document: IndexedDocumentRecord; name: string; rowCount: number }> = [];

  for (const document of documents) {
    if (document.structure?.kind !== "spreadsheet") {
      continue;
    }
    for (const sheet of document.structure.sheets ?? []) {
      fallbackSheets.push({ document, name: sheet.name, rowCount: sheet.rowCount });
      const score = scoreSpreadsheetSheet(sheet.name, sheet.headerHints ?? [], queryTokens);
      if (score > 0) {
        matchedSheets.push({ document, name: sheet.name, rowCount: sheet.rowCount, score });
      }
    }
  }

  if (queryProfile.wantsCount) {
    if (matchedSheets.length > 0) {
      matchedSheets.sort((left, right) => right.score - left.score);
      const totalRows = matchedSheets.reduce((sum, sheet) => sum + Math.max(sheet.rowCount, 0), 0);
      const details = matchedSheets.slice(0, 6).map((sheet) => `${sheet.name} (${sheet.rowCount})`).join(", ");
      notes.push(`Spreadsheet structure indicates ${totalRows} indexed data rows in sheets matching the question. ${details}`.trim());
      return {
        notes,
        totalRows,
        matchedByQuestion: true,
        sheetDetails: matchedSheets.map((sheet) => ({
          documentPath: sheet.document.relativePath,
          sheetName: sheet.name,
          rowCount: sheet.rowCount
        }))
      };
    }

    if (fallbackSheets.length > 0) {
      const totalRows = fallbackSheets.reduce((sum, sheet) => sum + Math.max(sheet.rowCount, 0), 0);
      const details = fallbackSheets.slice(0, 6).map((sheet) => `${sheet.name} (${sheet.rowCount})`).join(", ");
      notes.push(`Spreadsheet structure indicates ${totalRows} indexed data rows across the selected spreadsheet sheets. ${details}`.trim());
      return {
        notes,
        totalRows,
        matchedByQuestion: false,
        sheetDetails: fallbackSheets.map((sheet) => ({
          documentPath: sheet.document.relativePath,
          sheetName: sheet.name,
          rowCount: sheet.rowCount
        }))
      };
    }
  }

  return notes.length > 0 ? { notes } : null;
}

export function scoreSpreadsheetSheet(sheetName: string, headerHints: string[], queryTokens: string[]): number {
  const haystack = [sheetName, ...headerHints].join(" ").toLowerCase();
  let score = 0;
  for (const token of new Set(queryTokens)) {
    const count = haystack.split(token).length - 1;
    if (count > 0) {
      score += Math.min(count, 4);
    }
  }
  return score;
}

export function buildSpreadsheetCountAnswer(summary: NonNullable<ReturnType<typeof summarizeSpreadsheetStructureQuery>>): string | null {
  if (typeof summary.totalRows !== "number") {
    return null;
  }

  const leadingSheets = (summary.sheetDetails ?? [])
    .slice(0, 6)
    .map((sheet) => `${sheet.sheetName} (${sheet.rowCount})`)
    .join(", ");

  if (summary.matchedByQuestion) {
    return `Based on the indexed spreadsheet structure, there are ${summary.totalRows} data rows in sheets matching your question.${leadingSheets ? ` Matching sheets: ${leadingSheets}.` : ""}`;
  }

  return `Based on the indexed spreadsheet structure, there are ${summary.totalRows} data rows across the selected spreadsheet sheets.${leadingSheets ? ` Sheets counted: ${leadingSheets}.` : ""}`;
}