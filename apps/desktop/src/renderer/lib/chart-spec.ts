/**
 * The ```chart block schema that models are told to emit (see CHART_FORMAT_GUIDE in
 * main/providers/client.ts), plus a strict, pure validator.
 *
 *   {
 *     "type": "bar" | "stacked-bar" | "line" | "area" | "pie" | "scatter",
 *     "title": "Short title",
 *     "x": { "label": "Quarter", "values": ["Q1", "Q2", "Q3"] },
 *     "series": [ { "name": "Revenue", "values": [120, 135.5, null] } ],
 *     "unit": "USD k",                       // optional
 *     "source": "q1.xlsx, q2.xlsx"            // file names the numbers came from
 *   }
 *
 * Rules (anything else is rejected with a readable error):
 *  - type must be one of CHART_TYPES; title is required.
 *  - x.values: 1+ category labels (strings or numbers); for "scatter" they must all be numbers.
 *  - series: 1-8 entries, each with a name and exactly x.values.length values; every value is a
 *    finite number or null (a gap). Numeric strings such as "1,200" are NOT accepted.
 *  - "pie": exactly one series, no negative values.
 *  - At most MAX_CHART_POINTS values in total.
 *  - Unknown keys are ignored (never forwarded to the chart library). Long strings are truncated.
 * The spec is mapped to a chart-library option in code; model JSON is never passed through.
 */

export const CHART_TYPES = ["bar", "stacked-bar", "line", "area", "pie", "scatter"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const MAX_CHART_POINTS = 5000;
export const MAX_CHART_SERIES = 8;

export interface ChartSeries {
  name: string;
  values: (number | null)[];
}

export interface ChartSpec {
  type: ChartType;
  title: string;
  xLabel: string;
  xValues: (string | number)[];
  series: ChartSeries[];
  unit: string;
  source: string;
}

export type ChartParseResult = { ok: true; spec: ChartSpec } | { ok: false; error: string };

const MAX_TITLE = 200;
const MAX_LABEL = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Parses and validates the body of a ```chart block. Never throws. */
export function parseChartSpec(source: string): ChartParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    return { ok: false, error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  return validateChartSpec(raw);
}

export function validateChartSpec(raw: unknown): ChartParseResult {
  const fail = (error: string): ChartParseResult => ({ ok: false, error });
  if (!isRecord(raw)) return fail("The chart must be a JSON object.");

  const type = raw.type;
  if (typeof type !== "string" || !(CHART_TYPES as readonly string[]).includes(type)) {
    return fail(`Unknown chart type ${JSON.stringify(type)}. Use one of: ${CHART_TYPES.join(", ")}.`);
  }
  const chartType = type as ChartType;

  const title = text(raw.title, MAX_TITLE);
  if (!title) return fail('"title" is required.');

  if (!isRecord(raw.x)) return fail('"x" must be an object with "values".');
  const xValuesRaw = raw.x.values;
  if (!Array.isArray(xValuesRaw) || xValuesRaw.length === 0) return fail('"x.values" must be a non-empty array.');
  const xValues: (string | number)[] = [];
  for (const [index, value] of xValuesRaw.entries()) {
    if (typeof value === "number" && Number.isFinite(value)) xValues.push(value);
    else if (typeof value === "string" && chartType !== "scatter") xValues.push(text(value, MAX_LABEL));
    else
      return fail(
        chartType === "scatter"
          ? `"x.values[${index}]" must be a number for a scatter chart.`
          : `"x.values[${index}]" must be a string or number.`
      );
  }

  if (!Array.isArray(raw.series) || raw.series.length === 0) return fail('"series" must be a non-empty array.');
  if (raw.series.length > MAX_CHART_SERIES) return fail(`At most ${MAX_CHART_SERIES} series are supported.`);
  if (chartType === "pie" && raw.series.length !== 1) return fail("A pie chart takes exactly one series.");
  if (xValues.length * raw.series.length > MAX_CHART_POINTS) {
    return fail(`Too many data points (max ${MAX_CHART_POINTS}).`);
  }

  const series: ChartSeries[] = [];
  for (const [seriesIndex, item] of raw.series.entries()) {
    if (!isRecord(item)) return fail(`"series[${seriesIndex}]" must be an object.`);
    const name = text(item.name, MAX_LABEL) || `Series ${seriesIndex + 1}`;
    if (!Array.isArray(item.values)) return fail(`"series[${seriesIndex}].values" must be an array.`);
    if (item.values.length !== xValues.length) {
      return fail(
        `"series[${seriesIndex}].values" has ${item.values.length} values but "x.values" has ${xValues.length}.`
      );
    }
    const values: (number | null)[] = [];
    for (const [valueIndex, value] of item.values.entries()) {
      if (value === null) values.push(null);
      else if (typeof value === "number" && Number.isFinite(value)) {
        if (chartType === "pie" && value < 0) return fail("Pie chart values can't be negative.");
        values.push(value);
      } else {
        return fail(`"series[${seriesIndex}].values[${valueIndex}]" must be a number or null.`);
      }
    }
    series.push({ name, values });
  }

  return {
    ok: true,
    spec: {
      type: chartType,
      title,
      xLabel: text(raw.x.label, MAX_LABEL),
      xValues,
      series,
      unit: text(raw.unit, 40),
      source: text(raw.source, 400)
    }
  };
}

/** The chart's data as a grid (header row first), for "Show data" and "Copy data as CSV". */
export function chartSpecToRows(spec: ChartSpec): string[][] {
  const header = [spec.xLabel || "x", ...spec.series.map((item) => (spec.unit ? `${item.name} (${spec.unit})` : item.name))];
  const rows = spec.xValues.map((x, index) => [
    String(x),
    ...spec.series.map((item) => {
      const value = item.values[index];
      return value === null || value === undefined ? "" : String(value);
    })
  ]);
  return [header, ...rows];
}
