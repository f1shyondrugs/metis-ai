"use client";

import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { cn } from "@/lib/utils";

type RichComposerInputProps = {
  value: string;
  mentionLabels?: string[];
  onChange: (value: string, cursorPosition: number) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
  onFocus?: (event: FocusEvent<HTMLDivElement>) => void;
  onBlur?: (event: FocusEvent<HTMLDivElement>) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function linkPattern(mentionLabels: string[]) {
  const mentions = mentionLabels
    .map((label) => label.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  const mentionPart = mentions.length ? `@(?:${mentions.join("|")})` : "@[^\\s]+";
  return new RegExp(`(^|\\s)(${mentionPart}|https?:\\/\\/[^\\s]+)`, "g");
}

function formatText(element: HTMLDivElement, mentionLabels: string[]) {
  const text = element.innerText || "";
  const pattern = linkPattern(mentionLabels);
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;

  for (const match of text.matchAll(pattern)) {
    const matchStart = match.index ?? 0;
    const token = match[2];
    const tokenStart = matchStart + match[1].length;
    if (tokenStart > lastIndex) fragment.append(document.createTextNode(text.slice(lastIndex, tokenStart)));

    const link = document.createElement("a");
    link.href = token.startsWith("@") ? "#" : token;
    link.textContent = token;
    link.dataset.composerLink = "true";
    link.className = "underline underline-offset-2 hover:text-primary";
    link.addEventListener("click", (event) => event.preventDefault());
    fragment.append(link);
    lastIndex = tokenStart + token.length;
  }

  if (lastIndex < text.length) fragment.append(document.createTextNode(text.slice(lastIndex)));
  element.replaceChildren(fragment);
}

function caretOffset(element: HTMLDivElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return element.textContent?.length || 0;
  const range = selection.getRangeAt(0);
  const before = range.cloneRange();
  before.selectNodeContents(element);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().length;
}

function restoreCaret(element: HTMLDivElement, offset: number) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  let remaining = offset;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length || 0;
    if (remaining <= length) {
      range.setStart(node, remaining);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= length;
  }
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

export const RichComposerInput = forwardRef<HTMLDivElement, RichComposerInputProps>(
  function RichComposerInput(
    {
      value,
      mentionLabels = [],
      onChange,
      onKeyDown,
      onPaste,
      onFocus,
      onBlur,
      placeholder,
      className,
      disabled,
      "aria-label": ariaLabel,
    },
    ref,
  ) {
    const editorRef = useRef<HTMLDivElement>(null);
    useImperativeHandle(ref, () => editorRef.current as HTMLDivElement);

    useLayoutEffect(() => {
      const element = editorRef.current;
      if (!element || element.innerText === value) return;

      const isFocused = document.activeElement === element;
      const cursor = isFocused ? caretOffset(element) : null;
      element.textContent = value;
      formatText(element, mentionLabels);
      if (cursor !== null) restoreCaret(element, Math.min(cursor, value.length));
    }, [mentionLabels, value]);

    return (
      <div
        ref={editorRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        data-placeholder={placeholder}
        className={cn(
          "rich-composer-input min-h-9 max-h-[180px] flex-1 overflow-y-auto whitespace-pre-wrap rounded-none px-3 py-1.5 text-[15px] leading-6 outline-none",
          "focus-visible:ring-0",
          disabled && "pointer-events-none opacity-50",
          className,
        )}
        onInput={(event) => {
          const element = event.currentTarget;
          const cursor = caretOffset(element);
          const nextValue = element.innerText || "";
          formatText(element, mentionLabels);
          restoreCaret(element, cursor);
          onChange(nextValue, cursor);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onFocus={onFocus}
        onBlur={onBlur}
        onClick={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest("[data-composer-link]")) event.preventDefault();
        }}
      />
    );
  },
);
