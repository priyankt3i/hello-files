/** Lazy loader for the tree-shaken ECharts build in echarts-setup.ts (kept out of the initial bundle). */
export type EChartsModule = typeof import("echarts/core");

let loading: Promise<EChartsModule> | null = null;

export function loadECharts(): Promise<EChartsModule> {
  loading ??= import("./echarts-setup").then((module) => module.echarts);
  loading.catch(() => {
    loading = null;
  });
  return loading;
}
