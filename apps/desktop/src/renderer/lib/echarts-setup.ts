/**
 * Tree-shaken ECharts build: core + the chart types used by ```chart blocks + grid/tooltip/legend + the
 * SVG renderer. Only ever imported dynamically (see echarts-loader.ts) so it is a separate lazy chunk.
 */
import { BarChart, LineChart, PieChart, ScatterChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { SVGRenderer } from "echarts/renderers";

echarts.use([BarChart, LineChart, PieChart, ScatterChart, GridComponent, TooltipComponent, LegendComponent, SVGRenderer]);

export { echarts };
