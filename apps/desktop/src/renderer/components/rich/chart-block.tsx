import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, Image as ImageIcon, Table2 } from "lucide-react";
import type { ECharts } from "echarts/core";
import { chartSpecToOption } from "../../lib/chart-option";
import { chartSpecToRows, parseChartSpec, type ChartSpec } from "../../lib/chart-spec";
import { loadECharts } from "../../lib/echarts-loader";
import { copyText, exportFileName, savePng, saveSvg } from "../../lib/rich-export";
import { readChartPalette, readToken, useNearViewport, useResolvedTheme } from "../../lib/rich-theme";
import { toCsv } from "../../lib/table-export";
import { CodeBlock } from "./code-block";
import { ActionButton, BlockToolbar, ToolbarButton } from "./toolbar";

export function ChartBlock({ source }: { source: string }) {
  const parsed = useMemo(() => parseChartSpec(source), [source]);
  if (!parsed.ok) {
    return <CodeBlock code={source} language="chart" note={`Couldn't render chart: ${parsed.error}`} />;
  }
  return <ValidChart spec={parsed.spec} />;
}

function ValidChart({ spec }: { spec: ChartSpec }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<ECharts | null>(null);
  const visible = useNearViewport(rootRef);
  const theme = useResolvedTheme();
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [showData, setShowData] = useState(false);
  const rows = useMemo(() => chartSpecToRows(spec), [spec]);

  // Create the chart once it is near the viewport; dispose on unmount.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let observer: ResizeObserver | null = null;
    loadECharts().then(
      (echarts) => {
        const element = chartRef.current;
        if (cancelled || !element) return;
        const chart = echarts.init(element, null, { renderer: "svg" });
        instanceRef.current = chart;
        observer = new ResizeObserver(() => chart.resize());
        observer.observe(element);
        setReady(true);
      },
      (caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      }
    );
    return () => {
      cancelled = true;
      observer?.disconnect();
      instanceRef.current?.dispose();
      instanceRef.current = null;
      setReady(false);
    };
  }, [visible]);

  // (Re)apply the option when the spec or theme changes.
  useEffect(() => {
    const chart = instanceRef.current;
    if (!ready || !chart) return;
    try {
      chart.setOption(
        chartSpecToOption(spec, {
          palette: readChartPalette(),
          text: readToken("--text"),
          textMuted: readToken("--text-muted"),
          border: readToken("--border"),
          surface: readToken("--surface"),
          fontFamily: getComputedStyle(document.body).fontFamily || "sans-serif"
        }),
        true
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [ready, spec, theme]);

  function exportSvg() {
    const chart = instanceRef.current;
    const element = chartRef.current;
    if (!chart || !element) throw new Error("Chart not rendered.");
    return { markup: chart.renderToSVGString(), width: element.clientWidth, height: element.clientHeight };
  }

  const label = `${spec.title} (${spec.type} chart)`;
  return (
    <div className="rich-block" ref={rootRef}>
      <BlockToolbar title={spec.title} label={`${spec.title} chart actions`}>
        <ToolbarButton
          icon={Table2}
          label={showData ? "Hide data" : "Show data"}
          pressed={showData}
          onClick={() => setShowData((value) => !value)}
        />
        <ActionButton icon={Copy} label="Copy data as CSV" doneLabel="Copied" action={() => copyText(toCsv(rows))} />
        <ActionButton
          icon={Download}
          label="Save SVG"
          doneLabel="Saved"
          action={() => saveSvg(exportSvg().markup, exportFileName(spec.title, "svg", "chart"))}
        />
        <ActionButton
          icon={ImageIcon}
          label="Save PNG"
          doneLabel="Saved"
          action={async () => {
            const { markup, width, height } = exportSvg();
            await savePng(markup, width, height, readToken("--surface"), exportFileName(spec.title, "png", "chart"));
          }}
        />
      </BlockToolbar>
      {error ? <div className="rich-note rich-note-warning">Couldn&apos;t render chart: {error}</div> : null}
      <div className="relative">
        {/* ECharts owns this element's children; React never renders into it. */}
        <div ref={chartRef} className="rich-chart" role="img" aria-label={label} />
        {!ready && !error ? (
          <div className="rich-placeholder absolute inset-0" role="status">
            Loading chart…
          </div>
        ) : null}
      </div>
      {showData ? (
        <div className="rich-table-scroll border-t border-border" tabIndex={0} role="region" aria-label={`${spec.title} data`}>
          <table>
            <thead>
              <tr>
                {rows[0].map((cell, index) => (
                  <th key={index}>{cell}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(1).map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    <td key={index} style={index > 0 ? { textAlign: "right" } : undefined}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="rich-source">
        {spec.source ? `Based on: ${spec.source}` : "Source not stated. Check these numbers against the files."}
      </div>
    </div>
  );
}
