"use client";

import {
  memo,
  useEffect,
  useState,
  type AnchorHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
} from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import hljs from "highlight.js/lib/common";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github-dark.css";
import { normalizeMath, splitStreamingMath } from "@/lib/math";
import { LinkPreview } from "@/components/link-preview";
import { ThinkingBlock } from "@/components/thinking-block";
import { MermaidDiagram } from "@/components/mermaid-diagram";
import { isMermaidSource, wrapBareMermaid } from "@/lib/mermaid";
import { ExternalLink, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";

export { normalizeMath, splitStreamingMath } from "@/lib/math";

function MarkdownLink({
  href,
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const isWebUrl = Boolean(href && /^https?:\/\//i.test(href));
  const [hovered, setHovered] = useState(false);
  const [modifierHeld, setModifierHeld] = useState(false);
  useEffect(() => {
    if (!hovered) return;
    const updateModifier = (event: KeyboardEvent) => {
      if (event.key === "Control" || event.key === "Meta") setModifierHeld(true);
    };
    const clearModifier = (event: KeyboardEvent) => {
      if (event.key === "Control" || event.key === "Meta") setModifierHeld(false);
    };
    window.addEventListener("keydown", updateModifier);
    window.addEventListener("keyup", clearModifier);
    return () => {
      window.removeEventListener("keydown", updateModifier);
      window.removeEventListener("keyup", clearModifier);
    };
  }, [hovered]);
  const isSubagentUrl = Boolean(href && /^subagent:\/\//i.test(href));
  const workspaceMatch = href?.match(/^workspace:\/\/(plan|canvas)\/([^/?#]+)(?:[?#].*)?$/i);
  const noteMatch = href?.match(/^note:\/\/([^/?#]+)(?:[?#].*)?$/i);
  const automationMatch = href?.match(/^automation:\/\/([^/?#]+)(?:[?#].*)?$/i);
  const childText = typeof children === "string"
    ? children
    : Array.isArray(children)
      ? children.filter((child): child is string => typeof child === "string").join("")
      : "";
  const sourceTitle = childText.match(/^(?:source|quelle)\s*[:\-]\s*(.+)$/i)?.[1]?.trim();
  const link = (
    <a
      {...props}
      href={
        workspaceMatch
          ? `#workspace-${workspaceMatch[2]}`
          : noteMatch
            ? `#note-${noteMatch[1]}`
            : automationMatch
              ? `#automation-${automationMatch[1]}`
              : href
      }
      className={cn(
        props.className,
        sourceTitle && "inline-flex items-center gap-1 rounded-full border border-border/60 bg-secondary/60 px-1.5 py-0.5 text-[11px] font-medium no-underline hover:bg-secondary",
      )}
      onClick={(event) => {
        if (workspaceMatch) {
          event.preventDefault();
          event.stopPropagation();
          window.dispatchEvent(
            new CustomEvent("ai-chat:open-workspace", {
              detail: {
                type: workspaceMatch[1].toLowerCase(),
                id: decodeURIComponent(workspaceMatch[2]),
              },
            }),
          );
          return;
        }
        if (noteMatch) {
          event.preventDefault();
          event.stopPropagation();
          window.dispatchEvent(
            new CustomEvent("ai-chat:open-note", {
              detail: { id: decodeURIComponent(noteMatch[1]) },
            }),
          );
          return;
        }
        if (automationMatch) {
          event.preventDefault();
          event.stopPropagation();
          window.dispatchEvent(
            new CustomEvent("ai-chat:open-automations", {
              detail: { id: decodeURIComponent(automationMatch[1]) },
            }),
          );
          return;
        }
        if (isSubagentUrl && href) {
          event.preventDefault();
          window.dispatchEvent(
            new CustomEvent("ai-chat:open-subagent", {
              detail: href.slice("subagent://".length),
            }),
          );
          return;
        }
        if (!isWebUrl || !href) return;
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          window.open(href, "_blank", "noopener,noreferrer");
          return;
        }
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("ai-chat:open-browser", { detail: href }));
      }}
      onMouseEnter={(event) => {
        setHovered(true);
        setModifierHeld(event.ctrlKey || event.metaKey);
        props.onMouseEnter?.(event);
      }}
      onMouseLeave={(event) => {
        setHovered(false);
        setModifierHeld(false);
        props.onMouseLeave?.(event);
      }}
    >
      {sourceTitle ? (
        <>
          <Link2 className="size-3 shrink-0" aria-hidden="true" />
          {sourceTitle}
        </>
      ) : children}
      {isWebUrl && hovered && modifierHeld ? (
        <ExternalLink className="ml-1 inline size-3.5 animate-in fade-in text-muted-foreground" aria-label="Ctrl-click opens in a new tab" />
      ) : null}
    </a>
  );
  return isWebUrl && href ? <LinkPreview href={href}>{link}</LinkPreview> : link;
}

const markdownComponents = { a: MarkdownLink };

export interface ThinkingSegment {
  kind: "text" | "thinking";
  text: string;
  complete?: boolean;
}

export function splitThinkingBlocks(content: string): ThinkingSegment[] {
  const tagPattern = /<\/?thinking\s*>/gi;
  const segments: ThinkingSegment[] = [];
  let cursor = 0;
  let mode: ThinkingSegment["kind"] = "text";
  let thinkingStart = -1;

  for (const match of content.matchAll(tagPattern)) {
    const index = match.index ?? 0;
    const tag = match[0];
    const isClosing = tag.startsWith("</");

    if (mode === "text" && !isClosing) {
      if (index > cursor) segments.push({ kind: "text", text: content.slice(cursor, index) });
      mode = "thinking";
      thinkingStart = index + tag.length;
      cursor = thinkingStart;
    } else if (mode === "thinking" && isClosing) {
      if (index > thinkingStart) {
        segments.push({ kind: "thinking", text: content.slice(thinkingStart, index), complete: true });
      }
      mode = "text";
      cursor = index + tag.length;
    }
  }

  if (mode === "thinking") {
    segments.push({ kind: "thinking", text: content.slice(thinkingStart), complete: false });
  } else if (cursor < content.length || segments.length === 0) {
    segments.push({ kind: "text", text: content.slice(cursor) });
  }

  return segments.filter((segment) => segment.text.length > 0 || segment.kind === "thinking");
}

function transformMarkdownUrl(url: string) {
  if (/^(workspace|note|subagent|automation):\/\//i.test(url)) return url;
  return defaultUrlTransform(url);
}

function CodeBlock({
  className,
  children,
  inline,
  ...props
}: HTMLAttributes<HTMLElement> & { inline?: boolean }) {
  const code = String(children).replace(/\n$/, "");
  const isInline = inline ?? (!className && !code.includes("\n"));
  const [copied, setCopied] = useState(false);
  if (isInline) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  }
  const declaredLanguage = className?.match(/language-([\w-]+)/)?.[1];
  if (isMermaidSource(declaredLanguage, code)) {
    return <MermaidDiagram code={code} language={declaredLanguage} />;
  }
  const detectedLanguage =
    declaredLanguage && hljs.getLanguage(declaredLanguage)
      ? declaredLanguage
      : hljs.highlightAuto(code).language;
  const highlighted = detectedLanguage
    ? hljs.highlight(code, { language: detectedLanguage }).value
    : hljs.highlightAuto(code).value;
  return (
    <div className="group relative">
      <pre className="markdown-code-block" {...props}>
        <div className="mb-1.5 flex items-center justify-between text-[10px] font-sans uppercase tracking-wide text-muted-foreground/70">
          <span>{detectedLanguage || "text"}</span>
        </div>
        <code
          className={className}
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
      <button
        type="button"
        className="absolute top-2 right-2 rounded border border-border/50 bg-background/80 px-2 py-1 text-[10px] text-muted-foreground opacity-100 transition-opacity hover:text-foreground md:opacity-0 md:group-hover:opacity-100"
        onClick={() => {
          void navigator.clipboard.writeText(code).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function TaskCheckbox({
  interactive,
  checked,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { interactive?: boolean }) {
  const [value, setValue] = useState(Boolean(checked));
  useEffect(() => {
    setValue(Boolean(checked));
  }, [checked]);
  return (
    <input
      {...props}
      type="checkbox"
      checked={value}
      disabled={!interactive}
      contentEditable={false}
      onPointerDown={(event) => {
        event.stopPropagation();
        props.onPointerDown?.(event);
      }}
      onChange={(event) => {
        setValue(event.currentTarget.checked);
        if (interactive) {
          event.currentTarget.closest(".editable-markdown")?.dispatchEvent(
            new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }),
          );
        }
      }}
    />
  );
}

export const Markdown = memo(function Markdown({
  content,
  streaming = false,
  interactiveTasks = false,
  thinkingDurationMs,
}: {
  content: string;
  streaming?: boolean;
  interactiveTasks?: boolean;
  thinkingDurationMs?: number;
}) {
  const thinkingSegments = splitThinkingBlocks(content);
  if (thinkingSegments.some((segment) => segment.kind === "thinking")) {
    return (
      <div className="markdown-body">
        {thinkingSegments.map((segment, index) =>
          segment.kind === "thinking" ? (
            <ThinkingBlock
              key={`thinking-${index}`}
              text={segment.text}
              done={Boolean(segment.complete)}
              durationMs={thinkingDurationMs}
            />
          ) : segment.text ? (
            <Markdown
              key={`text-${index}`}
              content={segment.text}
              streaming={streaming}
              interactiveTasks={interactiveTasks}
              thinkingDurationMs={thinkingDurationMs}
            />
          ) : null,
        )}
      </div>
    );
  }

  const markdownComponentsWithCode = {
    ...markdownComponents,
    code: CodeBlock,
    input: (props: InputHTMLAttributes<HTMLInputElement>) => (
      <TaskCheckbox {...props} interactive={interactiveTasks} />
    ),
  };
  if (streaming) {
    const { ready, pending } = splitStreamingMath(content);
    return (
      <div className="markdown-body">
        {ready ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[
              [rehypeKatex, { throwOnError: false, strict: "ignore" }],
            ]}
            urlTransform={transformMarkdownUrl}
            components={markdownComponentsWithCode}
          >
            {wrapBareMermaid(ready)}
          </ReactMarkdown>
        ) : null}
        {pending ? (
          <span className="whitespace-pre-wrap text-muted-foreground/80">
            {pending}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [rehypeKatex, { throwOnError: false, strict: "ignore" }],
        ]}
        urlTransform={transformMarkdownUrl}
        components={markdownComponentsWithCode}
      >
        {wrapBareMermaid(normalizeMath(content))}
      </ReactMarkdown>
    </div>
  );
});

export const StreamingMarkdown = memo(function StreamingMarkdown({
  content,
  thinkingDurationMs,
}: {
  content: string;
  thinkingDurationMs?: number;
}) {
  return <Markdown content={content} streaming thinkingDurationMs={thinkingDurationMs} />;
});
