"use client";

import { FormEvent, Suspense, useEffect, useState } from "react";
import { AudioLines, ChevronDown, ClipboardList, FileText, Image as ImageIcon, Link2, LockKeyhole, LogIn, MessageSquareShare, Palette, Video } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Markdown } from "@/components/markdown";
import { ToolCallGroup, type ToolCallData } from "@/components/tool-call-chip";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

type SharedReference = {
  kind?: string;
  id?: string;
  label: string;
  detail?: string;
};

type SharedAttachment = {
  id: string;
  name: string;
  mimeType: string;
  kind: "image" | "file";
  storedName?: string;
  size?: number;
};

type SharedTool = ToolCallData;

type SharedSuggestion = {
  label: string;
  prompt: string;
};

type SharedMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  errorMessage?: string;
  referenceText?: string;
  thinking?: string;
  tools?: SharedTool[];
  attachments?: SharedAttachment[];
  references?: SharedReference[];
  suggestions?: SharedSuggestion[];
  runMetadata?: {
    modelId?: string;
    outputTokens?: number;
    completedAt: string;
  };
  createdAt: string;
};

function extractSources(content: string) {
  const sources = new Map<string, { label: string; url: string }>();
  const add = (url: string, label?: string) => {
    const clean = url.replace(/[),.;!?]+$/g, "");
    if (!/^https?:\/\//i.test(clean) || sources.has(clean)) return;
    let fallback = clean;
    try {
      fallback = new URL(clean).hostname.replace(/^www\./i, "");
    } catch {
      // Keep the URL as the fallback label.
    }
    sources.set(clean, { label: label?.trim() || fallback, url: clean });
  };
  for (const block of content.matchAll(/```sources\s*([\s\S]*?)```/gi)) {
    for (const match of block[1].matchAll(/\[([^\]]{1,200})\]\((https?:\/\/[^)\s]+)\)/gi)) add(match[2], match[1]);
    for (const match of block[1].matchAll(/https?:\/\/[^\s<>"'`)\]]+/gi)) add(match[0]);
  }
  return [...sources.values()].slice(0, 12);
}

function stripSourceBlocks(content: string) {
  return content.replace(/```sources\s*[\s\S]*?```/gi, "").replace(/\n{3,}/g, "\n\n").trim();
}

type SharedWorkspace = {
  id: string;
  type: "canvas" | "plan";
  name: string;
  content: string;
};

type SharedChat = {
  title: string;
  messages: SharedMessage[];
  workspaces?: SharedWorkspace[];
};

function workspaceFromTool(tool: SharedTool, workspaces: SharedWorkspace[] = []) {
  const link = [tool.path, tool.input, tool.result, tool.detail].find((value) => typeof value === "string" && value.includes("workspace://"));
  const match = link?.match(/workspace:\/\/(plan|canvas)\/([^)\s"'`]+)/);
  if (match) return workspaces.find((workspace) => workspace.id === match[2]) || null;
  return null;
}

function attachmentIcon(mimeType: string) {
  if (mimeType.startsWith("image/")) return <ImageIcon className="size-5 text-muted-foreground" />;
  if (mimeType.startsWith("video/")) return <Video className="size-5 text-muted-foreground" />;
  if (mimeType.startsWith("audio/")) return <AudioLines className="size-5 text-muted-foreground" />;
  return <FileText className="size-5 text-muted-foreground" />;
}

function SharedAttachmentCard({
  attachment,
  shareId,
  password,
  onOpen,
}: {
  attachment: SharedAttachment;
  shareId: string;
  password?: string;
  onOpen: (attachment: SharedAttachment, url: string) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    if (!attachment.storedName) return;
    const request = password
      ? fetch("/api/share/attachment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: shareId, name: attachment.storedName, password }),
        })
      : fetch(`/api/share/attachment?id=${encodeURIComponent(shareId)}&name=${encodeURIComponent(attachment.storedName)}`);
    void request
      .then((response) => {
        if (!response.ok) throw new Error("Attachment unavailable");
        return response.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.storedName, password, shareId]);

  return (
    <div className="flex w-52 shrink-0 items-center gap-2 rounded-xl border border-border/40 bg-background/40 p-2 text-left text-xs">
      {attachment.kind === "image" && url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={attachment.name} className="size-12 shrink-0 rounded-lg object-cover" />
      ) : (
        <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-secondary/80">
          {attachmentIcon(attachment.mimeType)}
        </span>
      )}
      <span className="min-w-0">
        <span className="block truncate font-medium">{attachment.name}</span>
        <span className="mt-0.5 block text-[11px] text-muted-foreground">
          {attachment.size === undefined ? "Size unavailable" : `${(attachment.size / 1024 / 1024).toFixed(2)} MB`}
        </span>
        {url ? (
          <button type="button" onClick={() => onOpen(attachment, url)} className="mt-1 block text-primary underline underline-offset-2">
            Open attachment
          </button>
        ) : null}
      </span>
    </div>
  );
}

function SharedMessageView({
  message,
  shareId,
  password,
  onOpenAttachment,
  onOpenWorkspace,
}: {
  message: SharedMessage;
  shareId: string;
  password?: string;
  onOpenAttachment: (attachment: SharedAttachment, url: string) => void;
  onOpenWorkspace: (tool: SharedTool) => void;
}) {
  const tools = message.tools || [];
  const sources = message.role === "assistant" ? extractSources(message.content) : [];
  return (
    <article className="w-full rounded-xl">
      {message.role === "user" ? (
        <div className="flex flex-col items-end gap-1">
          {message.references?.length ? (
            <div className="flex max-w-[85%] flex-wrap justify-end gap-1">
              {message.references.map((reference) => (
                <span
                  key={`${reference.kind}-${reference.id}-${reference.label}`}
                  title={reference.detail || reference.label}
                  className="inline-flex max-w-48 items-center gap-1 rounded-md border border-border/60 bg-muted/25 px-2 py-0.5 text-[11px] text-muted-foreground"
                >
                  <span className="truncate">@{reference.label}</span>
                </span>
              ))}
            </div>
          ) : null}
          {message.referenceText ? (
            <div className="flex max-w-[85%] items-start gap-2 rounded-lg border border-border/60 bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
              <span className="whitespace-pre-wrap break-words text-left">{message.referenceText}</span>
            </div>
          ) : null}
          <div className="max-w-[85%] space-y-2 rounded-xl bg-secondary/70 px-4 py-2.5 text-[15px] leading-relaxed">
            {message.attachments?.length ? (
              <div className="flex max-w-full gap-2 overflow-x-auto pb-1">
                {message.attachments.map((attachment) => (
                  <SharedAttachmentCard
                    key={attachment.id}
                    attachment={attachment}
                    shareId={shareId}
                    password={password}
                    onOpen={onOpenAttachment}
                  />
                ))}
              </div>
            ) : null}
            {message.content ? <div className="whitespace-pre-wrap">{message.content}</div> : null}
          </div>
        </div>
      ) : message.role === "system" ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {message.errorMessage || message.content}
        </div>
      ) : (
        <div className="text-[15px] leading-relaxed text-foreground/95">
          {message.thinking || tools.length ? (
            <ToolCallGroup
              thinking={message.thinking ? [{ text: message.thinking, done: true }] : []}
              tools={tools}
              includePlans
              autoExpand={false}
              onOpenWorkspace={onOpenWorkspace}
            />
          ) : null}
          {message.content ? <Markdown content={stripSourceBlocks(message.content)} /> : null}
          {message.errorMessage ? (
            <div className="mt-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {message.errorMessage}
            </div>
          ) : null}
          {message.runMetadata ? (
            <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              {typeof message.runMetadata.outputTokens === "number" ? <span>Output: {message.runMetadata.outputTokens} Tokens</span> : null}
              {message.runMetadata.modelId ? <span>Model: {message.runMetadata.modelId}</span> : null}
              <span>Completed: {new Date(message.runMetadata.completedAt).toLocaleString()}</span>
            </div>
          ) : null}
          {message.suggestions?.length ? (
            <div className="mt-3 flex flex-col items-start gap-1" aria-label="Suggested next steps">
              {message.suggestions.map((suggestion) => (
                <span key={`${suggestion.label}-${suggestion.prompt}`} className="text-xs text-muted-foreground">
                  <span className="mr-1.5 text-primary">↳</span>{suggestion.label}
                </span>
              ))}
            </div>
          ) : null}
          {sources.length ? (
            <details className="group mt-3 text-muted-foreground">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-medium marker:hidden [&::-webkit-details-marker]:hidden hover:text-foreground">
                <Link2 className="size-3.5 shrink-0" />
                <span>Sources</span>
                <span className="text-[10px] opacity-70">({sources.length})</span>
                <ChevronDown className="ml-auto size-3.5 opacity-60 transition-transform group-open:rotate-180" />
              </summary>
              <ol className="mt-1.5 space-y-1 pl-5">
                {sources.map((source, index) => (
                  <li key={source.url} className="flex min-w-0 items-start gap-2 text-xs">
                    <span className="mt-0.5 shrink-0 opacity-60">{index + 1}.</span>
                    <a href={source.url} target="_blank" rel="noreferrer" className="min-w-0 truncate underline decoration-border underline-offset-2">
                      {source.label}
                    </a>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </div>
      )}
    </article>
  );
}

function ShareView() {
  const searchParams = useSearchParams();
  const shareId = searchParams.get("id") || "";
  const [chat, setChat] = useState<SharedChat | null>(null);
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [username, setUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginOpen, setLoginOpen] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [cloneError, setCloneError] = useState("");
  const [clonedChatId, setClonedChatId] = useState("");
  const [selectedAttachment, setSelectedAttachment] = useState<{ attachment: SharedAttachment; url: string } | null>(null);
  const [selectedWorkspace, setSelectedWorkspace] = useState<SharedWorkspace | null>(null);

  async function loadShare(nextPassword?: string) {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/share?id=${encodeURIComponent(shareId)}`, {
        method: nextPassword === undefined ? "GET" : "POST",
        headers: nextPassword === undefined ? undefined : { "Content-Type": "application/json" },
        body: nextPassword === undefined ? undefined : JSON.stringify({ id: shareId, password: nextPassword }),
        ...(nextPassword === undefined ? { cache: "no-store" as const } : {}),
      });
      const data = (await res.json().catch(() => ({}))) as {
        chat?: SharedChat;
        error?: string;
      };
      if (res.status === 401) {
        setNeedsPassword(true);
        setError(nextPassword ? data.error || "Incorrect password" : "");
        return;
      }
      if (!res.ok || !data.chat) throw new Error(data.error || "This share link is unavailable.");
      setChat(data.chat);
      setNeedsPassword(false);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load this shared chat.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (shareId) void loadShare();
    else {
      setError("Missing share link.");
      setLoading(false);
    }
  }, [shareId]);

  useEffect(() => {
    void fetch("/api/status", { cache: "no-store" })
      .then((response) => response.json() as Promise<{ authenticated?: boolean }>)
      .then((data) => setAuthenticated(Boolean(data.authenticated)))
      .catch(() => setAuthenticated(false));
  }, []);

  function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.trim()) void loadShare(password);
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginError("");
    const response = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: loginPassword }),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      setLoginError(data.error || "Unable to sign in.");
      return;
    }
    setLoginPassword("");
    setAuthenticated(true);
    setLoginOpen(false);
  }

  async function cloneChat() {
    setCloning(true);
    setCloneError("");
    const response = await fetch("/api/share/clone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: shareId, password: password || undefined }),
    });
    const data = (await response.json().catch(() => ({}))) as { chat?: { id: string }; error?: string };
    if (!response.ok || !data.chat?.id) {
      setCloneError(data.error || "Unable to clone this chat.");
      setCloning(false);
      return;
    }
    setClonedChatId(data.chat.id);
    setCloning(false);
  }

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6">
      <div className="mx-auto max-w-3xl">
        <header className="mb-8 flex items-center gap-3 border-b border-border/60 pb-5">
          <span className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <MessageSquareShare className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Shared chat</p>
            <h1 className="truncate text-lg font-semibold">{chat?.title || "Shared conversation"}</h1>
          </div>
        </header>
        {loading ? <p className="text-sm text-muted-foreground">Loading shared chat…</p> : null}
        {!loading && needsPassword ? (
          <form onSubmit={submitPassword} className="mx-auto max-w-sm space-y-3 rounded-2xl border border-border/60 bg-card p-5 shadow-sm">
            <div className="flex items-center gap-2 text-sm font-medium">
              <LockKeyhole className="size-4 text-muted-foreground" />
              Password-protected chat
            </div>
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter password"
              autoFocus
              autoComplete="off"
              aria-label="Share password"
            />
            <Button type="submit" className="w-full" disabled={!password.trim()}>Unlock</Button>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </form>
        ) : null}
        {!loading && !needsPassword && error ? <p className="text-sm text-destructive">{error}</p> : null}
        {chat ? (
          <div className="space-y-6">
            {chat.messages.map((message) => (
              <SharedMessageView
                key={message.id}
                message={message}
                shareId={shareId}
                password={password}
                onOpenAttachment={(attachment, url) => setSelectedAttachment({ attachment, url })}
                onOpenWorkspace={(tool) => {
                  const workspace = workspaceFromTool(tool, chat.workspaces);
                  if (workspace) setSelectedWorkspace(workspace);
                }}
              />
            ))}
            {chat.workspaces?.length ? (
              <section className="space-y-3 border-t border-border/60 pt-6">
                <h2 className="text-sm font-medium">Shared plans & canvas</h2>
                <div className="grid gap-2 sm:grid-cols-2">
                  {chat.workspaces.map((workspace) => (
                    <button
                      key={workspace.id}
                      type="button"
                      onClick={() => setSelectedWorkspace(workspace)}
                      className="rounded-xl border border-border/60 bg-card/50 p-3 text-left transition-colors hover:bg-muted/50"
                    >
                      <span className="flex items-center gap-2">
                        <span className="flex size-7 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground">
                          {workspace.type === "plan" ? <ClipboardList className="size-4" /> : <Palette className="size-4" />}
                        </span>
                        <span>
                          <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">{workspace.type}</span>
                          <span className="block truncate text-sm font-medium">{workspace.name}</span>
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : null}
        {chat ? (
          <section className="sticky bottom-0 z-20 -mx-4 mt-10 border-t border-border/50 bg-background px-4 pb-4 pt-4 sm:-mx-6 sm:px-6">
            {clonedChatId ? (
              <div className="flex w-full flex-wrap items-center justify-between gap-3 rounded-xl border border-border/65 bg-card p-2 shadow-[0_1px_2px_rgba(0,0,0,0.16)]">
                <div className="min-w-0 px-3 py-1">
                  <p className="text-sm font-medium">Chat cloned</p>
                  <p className="text-xs text-muted-foreground">It is now in your chats and ready to continue.</p>
                </div>
                <Button asChild className="rounded-lg">
                  <a href={`/?c=${encodeURIComponent(clonedChatId)}`}>Open cloned chat</a>
                </Button>
              </div>
            ) : authenticated ? (
              <div className="w-full rounded-xl border border-border/65 bg-card p-2 shadow-[0_1px_2px_rgba(0,0,0,0.16)]">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 px-3 py-1">
                    <p className="text-sm font-medium">Continue this chat</p>
                    <p className="text-xs text-muted-foreground">Create your own copy and keep chatting.</p>
                  </div>
                  <Button onClick={() => void cloneChat()} disabled={cloning} className="rounded-lg">
                    {cloning ? "Cloning…" : "Clone this chat"}
                  </Button>
                </div>
                {cloneError ? <p className="px-3 pt-2 text-sm text-destructive">{cloneError}</p> : null}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setLoginOpen(true)}
                className="flex w-full items-center justify-between gap-4 rounded-xl border border-border/70 bg-card px-4 py-3 text-left transition-colors hover:bg-muted/35"
              >
                <span className="min-w-0">
                  <span className="block text-sm font-medium">Log in to clone this chat</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Sign in to create your own copy and keep chatting.
                  </span>
                </span>
                <LogIn className="size-5 shrink-0 text-muted-foreground" />
              </button>
            )}
          </section>
        ) : null}
      </div>
      <Dialog open={loginOpen} onOpenChange={setLoginOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Log in to clone this chat</DialogTitle>
          </DialogHeader>
          <form onSubmit={login} className="space-y-3">
            <Input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Username"
              autoComplete="username"
              autoFocus
            />
            <Input
              type="password"
              value={loginPassword}
              onChange={(event) => setLoginPassword(event.target.value)}
              placeholder="Password"
              autoComplete="current-password"
            />
            {loginError ? <p className="text-sm text-destructive">{loginError}</p> : null}
            <Button type="submit" className="w-full" disabled={!loginPassword || authenticated === null}>
              Log in
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(selectedAttachment)} onOpenChange={(open) => !open && setSelectedAttachment(null)}>
        <DialogContent className="h-[100dvh] max-h-none w-screen max-w-none rounded-none p-4 sm:h-auto sm:max-h-[90vh] sm:max-w-5xl sm:rounded-xl sm:p-6">
          <DialogHeader>
            <DialogTitle className="truncate pr-8">{selectedAttachment?.attachment.name || "Attachment"}</DialogTitle>
          </DialogHeader>
          <div className="flex min-h-0 max-h-[calc(100dvh-7rem)] items-center justify-center overflow-auto sm:max-h-[78vh]">
            {selectedAttachment?.attachment.mimeType.startsWith("image/") ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={selectedAttachment.url} alt={selectedAttachment.attachment.name} className="max-h-[78vh] max-w-full object-contain" />
            ) : selectedAttachment?.attachment.mimeType.startsWith("video/") ? (
              <video src={selectedAttachment.url} controls className="max-h-[78vh] max-w-full" />
            ) : selectedAttachment?.attachment.mimeType.startsWith("audio/") ? (
              <audio src={selectedAttachment.url} controls className="w-full" />
            ) : selectedAttachment?.attachment.mimeType === "application/pdf" ? (
              <div className="flex flex-col items-center gap-3 text-center">
                <p className="text-sm text-muted-foreground">PDF previews are not available.</p>
                <a
                  href={selectedAttachment.url}
                  download={selectedAttachment.attachment.name}
                  className="rounded-lg border border-border/60 px-4 py-2 text-sm hover:bg-muted"
                >
                  Download {selectedAttachment.attachment.name}
                </a>
              </div>
            ) : selectedAttachment ? (
              <a href={selectedAttachment.url} download={selectedAttachment.attachment.name} className="rounded-lg border border-border/60 px-4 py-2 text-sm hover:bg-muted">
                Download {selectedAttachment.attachment.name}
              </a>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(selectedWorkspace)} onOpenChange={(open) => !open && setSelectedWorkspace(null)}>
        <DialogContent className="h-[100dvh] max-h-none w-screen max-w-none rounded-none p-4 sm:h-auto sm:max-h-[90vh] sm:max-w-5xl sm:rounded-xl sm:p-6">
          <DialogHeader>
            <DialogTitle>{selectedWorkspace?.name || "Workspace"}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 max-h-[calc(100dvh-7rem)] overflow-auto rounded-lg bg-muted/40 p-4 text-sm leading-6 sm:max-h-[75vh]">
            {selectedWorkspace ? <Markdown content={selectedWorkspace.content} /> : null}
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}

export default function SharePage() {
  return (
    <Suspense fallback={<main className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">Loading shared chat…</main>}>
      <ShareView />
    </Suspense>
  );
}
