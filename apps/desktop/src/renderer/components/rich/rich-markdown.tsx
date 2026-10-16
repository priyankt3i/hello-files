import {
  createContext,
  isValidElement,
  lazy,
  memo,
  Suspense,
  useContext,
  type MouseEvent,
  type ReactElement,
  type ReactNode
} from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { isExternalHttpUrl, safeUrlTransform } from "../../lib/markdown";
import { CodeBlock } from "./code-block";
import { TableBlock, type HastLike } from "./table-block";

/*
 * Assistant answer renderer: react-markdown + remark-gfm (tables, strikethrough, task lists, autolinks).
 * Raw HTML from the model is never interpreted (no rehype-raw) and rehype-sanitize runs as defence in depth.
 * ```mermaid and ```chart blocks are rendered by lazily loaded components (separate chunks).
 */

const MermaidBlock = lazy(() => import("./mermaid-block").then((module) => ({ default: module.MermaidBlock })));
const ChartBlock = lazy(() => import("./chart-block").then((module) => ({ default: module.ChartBlock })));

/** Opens http(s) links externally (window.fsChat.openExternalUrl via the store). Provide a stable function. */
export const RichLinkContext = createContext<(url: string) => void>(() => undefined);

function ExternalLink({ href, children }: { href?: string; children?: ReactNode }) {
  const openUrl = useContext(RichLinkContext);
  if (!isExternalHttpUrl(href)) {
    // mailto: and anything else is shown as text: the main process only opens http(s) URLs.
    return <span title={href || undefined}>{children}</span>;
  }
  return (
    <a
      href={href}
      data-external-link="true"
      rel="noopener noreferrer nofollow"
      title={href}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        openUrl(href);
      }}
    >
      {children}
    </a>
  );
}

function BlockFallback({ label }: { label: string }) {
  return (
    <div className="rich-block">
      <div className="rich-placeholder" role="status">
        {label}
      </div>
    </div>
  );
}

function Pre({ children }: { children?: ReactNode }) {
  const code = Array.isArray(children) ? children.find(isValidElement) : children;
  if (!isValidElement(code)) return <pre>{children}</pre>;
  const props = (code as ReactElement<{ className?: string; children?: ReactNode }>).props;
  const language = /(?:^|\s)language-([\w-]+)/.exec(props.className ?? "")?.[1]?.toLowerCase() ?? "";
  const text = String(Array.isArray(props.children) ? props.children.join("") : (props.children ?? "")).replace(/\n$/, "");

  if (language === "mermaid") {
    return (
      <Suspense fallback={<BlockFallback label="Loading diagram…" />}>
        <MermaidBlock source={text} />
      </Suspense>
    );
  }
  if (language === "chart") {
    return (
      <Suspense fallback={<BlockFallback label="Loading chart…" />}>
        <ChartBlock source={text} />
      </Suspense>
    );
  }
  return <CodeBlock code={text} language={language} />;
}

const components: Components = {
  a: ({ href, children }) => <ExternalLink href={href}>{children}</ExternalLink>,
  // Images in model output are never fetched; show the alt text instead.
  img: ({ alt }) => <span className="text-text-muted">{alt ? `[image: ${alt}]` : "[image]"}</span>,
  pre: ({ children }) => <Pre>{children}</Pre>,
  table: ({ node, children }) => <TableBlock node={node as HastLike | undefined}>{children}</TableBlock>
};

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeSanitize];

/** Memoised per content string, so long threads don't re-parse every answer on each render. */
export const RichMarkdown = memo(function RichMarkdown({ content }: { content: string }) {
  return (
    <div className="markdown-body break-anywhere text-sm text-text">
      <Markdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={safeUrlTransform}
        skipHtml
      >
        {content}
      </Markdown>
    </div>
  );
});
