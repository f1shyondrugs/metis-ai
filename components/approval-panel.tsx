"use client";

import { Check, FilePen, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PendingApprovalView = {
  id: string;
  title: string;
  command?: string;
  files?: Array<{ path: string; status: string }>;
  createdAt: string;
};

export type ApprovalDecisionValue = "allow" | "allow-session" | "deny";

const APPROVAL_ICONS = {
  "approval-required": ShieldAlert,
  "auto-accept-edits": FilePen,
} as const;

export function ApprovalPanel({
  approval,
  disabled,
  onDecision,
}: {
  approval: PendingApprovalView;
  disabled?: boolean;
  onDecision: (decision: ApprovalDecisionValue) => void;
}) {
  const command = approval.command?.trim();
  const Icon = APPROVAL_ICONS["approval-required"];
  return (
    <section
      className="rounded-xl border border-border bg-background p-4"
      aria-label="Action approval required"
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">
            {approval.title || "Command approval required"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Allow or deny this action before the agent continues.
          </p>
        </div>
      </div>
      {command ? (
        <code className="mt-3 block max-h-32 overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs whitespace-pre text-foreground">
          {command}
        </code>
      ) : null}
      {approval.files?.length ? (
        <div className="mt-3 space-y-1">
          {approval.files.map((file) => (
            <p key={`${file.path}-${file.status}`} className="truncate font-mono text-xs text-muted-foreground">
              {file.path}
              {file.status ? ` — ${file.status}` : ""}
            </p>
          ))}
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <Button type="button" size="sm" disabled={disabled} onClick={() => onDecision("allow")}>
          <Check className="size-3.5" />
          Allow
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={disabled}
          title="Für diesen Chat nicht wieder nachfragen (Präfix-Match)"
          onClick={() => onDecision("allow-session")}
        >
          Allow session
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onDecision("deny")}>
          Deny
        </Button>
      </div>
    </section>
  );
}

export function RuntimeModeIcon({
  mode,
  className,
}: {
  mode: string;
  className?: string;
}) {
  const Icon = APPROVAL_ICONS[mode as keyof typeof APPROVAL_ICONS] ?? Check;
  return <Icon className={cn("size-4", className)} />;
}
