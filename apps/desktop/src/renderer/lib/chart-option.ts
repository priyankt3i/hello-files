/**
 * Maps a validated ChartSpec (lib/chart-spec.ts) to an ECharts option. This is the ONLY place an
 * ECharts option is built: model JSON is never passed through, and only the fields below are set.
 * Tooltips use renderMode "richText" so no HTML is generated from model-provided names.
 */
import type { EChartsCoreOption } from "echarts/core";
import type { ChartSpec } from "./chart-spec";

export interface ChartColors {
  palette: string[];
  text: string;
  textMuted: string;
  border: string;
  surface: string;
  fontFamily: string;
}

const PIE_MAX_SLICES = 8;

export function chartSpecToOption(spec: ChartSpec, colors: ChartColors): EChartsCoreOption {
  const unitSuffix = spec.unit ? ` ${spec.unit}` : "";
  const formatValue = (value: unknown) =>
    typeof value === "number" ? `${value.toLocaleString()}${unitSuffix}` : value === null || value === undefined ? "–" : String(value);

  const base = {
    animationDuration: 300,
    color: colors.palette,
    backgroundColor: "transparent",
    textStyle: { color: colors.text, fontFamily: colors.fontFamily },
    tooltip: {
      renderMode: "richText",
      trigger: spec.type === "pie" || spec.type === "scatter" ? "item" : "axis",
      backgroundColor: colors.surface,
      borderColor: colors.border,
      textStyle: { color: colors.text },
      valueFormatter: formatValue,
      axisPointer: { type: spec.type === "line" || spec.type === "area" ? "line" : "shadow" }
    },
    legend:
      spec.series.length > 1 || spec.type === "pie"
        ? { type: "scroll", bottom: 0, textStyle: { color: colors.text }, pageTextStyle: { color: colors.textMuted } }
        : undefined
  };
  const hasLegend = Boolean(base.legend);

  if (spec.type === "pie") {
    const series = spec.series[0];
    let slices = spec.xValues
      .map((x, index) => ({ name: String(x), value: series.values[index] }))
      .filter((slice): slice is { name: string; value: number } => typeof slice.value === "number");
    if (slices.length > PIE_MAX_SLICES) {
      // Fixed-order palette has 8 slots; fold the smallest slices into "Other" instead of cycling colours.
      const sorted = [...slices].sort((a, b) => b.value - a.value);
      const kept = sorted.slice(0, PIE_MAX_SLICES - 1);
      const other = sorted.slice(PIE_MAX_SLICES - 1).reduce((sum, slice) => sum + slice.value, 0);
      slices = [...kept, { name: "Other", value: other }];
    }
    return {
      ...base,
      series: [
        {
          type: "pie",
          name: series.name,
          radius: ["38%", "68%"],
          center: ["50%", "45%"],
          data: slices,
          itemStyle: { borderColor: colors.surface, borderWidth: 2 },
          label: { color: colors.text, formatter: "{b}: {d}%" },
          labelLine: { lineStyle: { color: colors.textMuted } }
        }
      ]
    };
  }

  const axisCommon = {
    axisLine: { lineStyle: { color: colors.border } },
    axisTick: { lineStyle: { color: colors.border } },
    axisLabel: { color: colors.textMuted, hideOverlap: true },
    nameTextStyle: { color: colors.textMuted },
    splitLine: { lineStyle: { color: colors.border, opacity: 0.6 } }
  };
  const grid = { left: 12, right: 24, top: spec.unit ? 32 : 16, bottom: hasLegend ? 36 : 8 };
  const yAxis = { type: "value", name: spec.unit || undefined, ...axisCommon };

  if (spec.type === "scatter") {
    return {
      ...base,
      grid,
      xAxis: { type: "value", name: spec.xLabel || undefined, nameLocation: "middle", nameGap: 26, scale: true, ...axisCommon },
      yAxis: { ...yAxis, scale: true },
      series: spec.series.map((item) => ({
        type: "scatter",
        name: item.name,
        symbolSize: 9,
        itemStyle: { borderColor: colors.surface, borderWidth: 1 },
        data: spec.xValues.flatMap((x, index) => {
          const y = item.values[index];
          return typeof y === "number" ? [[x as number, y]] : [];
        })
      }))
    };
  }

  const categories = spec.xValues.map(String);
  const showSymbols = categories.length <= 40;
  return {
    ...base,
    grid: { ...grid, bottom: grid.bottom + (spec.xLabel ? 20 : 0) },
    xAxis: {
      type: "category",
      data: categories,
      name: spec.xLabel || undefined,
      nameLocation: "middle",
      nameGap: 28,
      boundaryGap: spec.type === "bar" || spec.type === "stacked-bar",
      ...axisCommon,
      splitLine: { show: false }
    },
    yAxis,
    series: spec.series.map((item) => {
      if (spec.type === "bar" || spec.type === "stacked-bar") {
        const stacked = spec.type === "stacked-bar";
        return {
          type: "bar",
          name: item.name,
          data: item.values,
          stack: stacked ? "total" : undefined,
          barMaxWidth: 36,
          itemStyle: stacked
            ? { borderColor: colors.surface, borderWidth: 1 }
            : { borderRadius: [4, 4, 0, 0] }
        };
      }
      return {
        type: "line",
        name: item.name,
        data: item.values,
        showSymbol: showSymbols,
        symbolSize: 7,
        connectNulls: false,
        lineStyle: { width: 2 },
        areaStyle: spec.type === "area" ? { opacity: 0.15 } : undefined
      };
    })
  };
}
