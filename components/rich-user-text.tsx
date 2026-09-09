"use client";

import { LinkPreview } from "@/components/link-preview";
import { parseRichUserText } from "@/lib/user-text-links";
import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

type Reference = {
  kind?: string;
  id?: string;
  label: string;
  chatId?: string;
  path?: string;
  sessionId?: string;
};

function dispatchInternalLink(href: string, label: string) {
  const workspaceMatch = href.match(/^workspace:\/\/(plan|canvas)\/([^/?#]+)(?:[?#].*)?$/i);
  if (workspaceMatch) {
    window.dispatchEvent(
      new CustomEvent("ai-chat:open-workspace", {
        detail: {
          type: workspaceMatch[1].toLowerCase(),
          id: decodeURIComponent(workspaceMatch[2]),
        },
      }),
    );
    return true;
  }
  const noteMatch = href.match(/^note:\/\/([^/?#]+)(?:[?#].*)?$/i);
  if (noteMatch) {
    window.dispatchEvent(
      new CustomEvent("ai-chat:open-note", {
        detail: { id: decodeURIComponent(noteMatch[1]) },
      }),
    );
    return true;
  }
  const automationMatch = href.match(/^automation:\/\/([^/?#]+)(?:[?#].*)?$/i);
  if (automationMatch) {
    window.dispatchEvent(
      new CustomEvent("ai-chat:open-automations", {
        detail: { id: decodeURIComponent(automationMatch[1]) },
      }),
    );
    return true;
  }
  return false;
}

function RichLink({ href, children }: { href: string; children: string }) {
  const [hovered, setHovered] = useState(false);
  const [modifierHeld, setModifierHeld] = useState(false);
  const internal = /^(workspace|note|automation):\/\//i.test(href);
  useEffect(() => {
    if (!hovered || internal) return;
    const update = (event: KeyboardEvent) => {
      if (event.key === "Control" || event.key === "Meta") setModifierHeld(true);
    };
    const clear = (event: KeyboardEvent) => {
      if (event.key === "Control" || event.key === "Meta") setModifierHeld(false);
    };
    window.addEventListener("keydown", update);
    window.addEventListener("keyup", clear);
    return () => {
      window.removeEventListener("keydown", update);
      window.removeEventListener("keyup", clear);
    };
  }, [hovered, internal]);
  return (
    <a
      href={href}
      className="inline-flex items-center underline underline-offset-2 hover:text-primary"
      onMouseEnter={(event) => {
        setHovered(true);
        setModifierHeld(event.ctrlKey || event.metaKey);
      }}
      onMouseLeave={() => {
        setHovered(false);
        setModifierHeld(false);
      }}
      onClick={(event) => {
        event.preventDefault();
        if (dispatchInternalLink(href, children)) return;
        if (event.ctrlKey || event.metaKey) {
          window.open(href, "_blank", "noopener,noreferrer");
          return;
        }
        window.dispatchEvent(new CustomEvent("ai-chat:open-browser", { detail: href }));
      }}
    >
      {children}
      {hovered && modifierHeld && !internal ? (
        <ExternalLink className="ml-1 size-3.5 animate-in fade-in text-muted-foreground" aria-label="Ctrl-click opens in a new tab" />
      ) : null}
    </a>
  );
}

export function RichUserText({
  content,
  references = [],
}: {
  content: string;
  references?: Reference[];
}) {
  const labels = references
    .map((reference) => reference.label.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const parts = parseRichUserText(content, labels);

  return (
    <>
      {parts.map((part, index) => {
        if (part.kind === "mention") {
          const reference = references.find(
            (item) => `@${item.label.trim()}` === part.text,
          );
          return (
            <button
              key={`${part.text}-${index}`}
              type="button"
              className="inline cursor-pointer border-0 bg-transparent p-0 text-primary underline underline-offset-2 hover:text-primary/80"
              title={reference ? `Open ${reference.label}` : part.text}
              onClick={() => {
                if (!reference?.kind || !reference.id) return;
                window.dispatchEvent(
                  new CustomEvent("ai-chat:open-reference", {
                    detail: { ...reference, label: reference.label.trim() },
                  }),
                );
              }}
            >
              {part.text}
            </button>
          );
        }
        if (part.kind === "link") {
          const internal = /^(workspace|note|automation):\/\//i.test(part.href);
          const link = <RichLink href={part.href}>{part.label}</RichLink>;
          return internal ? (
            <span key={`${part.href}-${index}`}>{link}</span>
          ) : (
            <LinkPreview key={`${part.href}-${index}`} href={part.href}>
              {link}
            </LinkPreview>
          );
        }
        return <span key={`${part.text}-${index}`}>{part.text}</span>;
      })}
    </>
  );
}
