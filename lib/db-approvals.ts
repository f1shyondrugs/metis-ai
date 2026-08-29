import { randomUUID } from "node:crypto";

import { getDatabase, transaction } from "@/lib/sqlite";
import type { ApprovalDecision } from "@/lib/runtime-mode";

export type ApprovalStatus = "waiting_for_user" | "resolved";

export type ApprovalFile = { path: string; status: string };

export type PendingApproval = {
  approvalId: string;
  jobId?: string;
  chatId: string;
  ownerId?: string;
  status: ApprovalStatus;
  title: string;
  command?: string;
  files?: ApprovalFile[];
  createdAt: string;
  heartbeatAt?: string;
  resolvedAt?: string;
  decision?: ApprovalDecision;
  sessionScope?: string;
  version: number;
};

const iso = () => new Date().toISOString();

export function approvalLimits() {
  return {
    maxApprovalsPerChat: 8,
    maxTitleLength: 500,
    maxCommandLength: 20_000,
    maxFiles: 100,
    maxPatterns: 100,
    timeoutMs: 10 * 60_000,
  };
}

function normalizeDecision(value: unknown): ApprovalDecision | null {
  return value === "allow" || value === "allow-session" || value === "deny"
    ? value
    : null;
}

function normalizeFiles(value: unknown): ApprovalFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record =
        item && typeof item === "object"
          ? (item as Record<string, unknown>)
          : {};
      return {
        path: String(record.path || "")
          .trim()
          .slice(0, 2_000),
        status: String(record.status || "")
          .trim()
          .slice(0, 100),
      };
    })
    .filter((item) => item.path)
    .slice(0, approvalLimits().maxFiles);
}

function mapApproval(row: unknown): PendingApproval | null {
  const record =
    row && typeof row === "object" ? (row as Record<string, unknown>) : {};
  const approvalId = String(record.id || "");
  const chatId = String(record.chatId || record.chat_id || "");
  if (!approvalId || !chatId) return null;
  let files: ApprovalFile[] = [];
  try {
    files = normalizeFiles(
      JSON.parse(String(record.filesJson ?? record.files_json ?? "[]")),
    );
  } catch {
    files = [];
  }
  const decision = normalizeDecision(record.decision);
  const status =
    String(record.status || "") === "resolved"
      ? "resolved"
      : "waiting_for_user";
  return {
    approvalId,
    ...((record.jobId ?? record.job_id)
      ? { jobId: String(record.jobId ?? record.job_id) }
      : {}),
    chatId,
    ...((record.ownerId ?? record.owner_id)
      ? { ownerId: String(record.ownerId ?? record.owner_id) }
      : {}),
    status,
    title: String(record.title || "Action approval required"),
    ...(record.command ? { command: String(record.command) } : {}),
    ...(files.length ? { files } : {}),
    createdAt: String(record.createdAt || record.created_at || ""),
    ...((record.heartbeatAt ?? record.heartbeat_at)
      ? { heartbeatAt: String(record.heartbeatAt ?? record.heartbeat_at) }
      : {}),
    ...((record.resolvedAt ?? record.resolved_at)
      ? { resolvedAt: String(record.resolvedAt ?? record.resolved_at) }
      : {}),
    ...(decision ? { decision } : {}),
    ...((record.sessionScope ?? record.session_scope)
      ? { sessionScope: String(record.sessionScope ?? record.session_scope) }
      : {}),
    version: Number.isFinite(Number(record.version))
      ? Math.max(1, Math.floor(Number(record.version)))
      : 1,
  };
}

function selectOne(approvalId: string) {
  return getDatabase()
    .prepare(
      `SELECT id, job_id as jobId, chat_id as chatId, owner_id as ownerId, status, title, command,
            files_json as filesJson, created_at as createdAt, heartbeat_at as heartbeatAt,
            resolved_at as resolvedAt, decision, session_scope as sessionScope, version
     FROM pending_approvals WHERE id = ?`,
    )
    .get(approvalId);
}

export function createApproval(input: {
  jobId?: string;
  chatId: string;
  ownerId?: string;
  title: string;
  command?: string;
  files?: ApprovalFile[];
  sessionScope?: string;
}): { approvalId: string } {
  const limits = approvalLimits();
  const title = String(input.title || "")
    .trim()
    .slice(0, limits.maxTitleLength);
  const command =
    String(input.command || "")
      .trim()
      .slice(0, limits.maxCommandLength) || undefined;
  const files = normalizeFiles(input.files);
  const sessionScope =
    String(input.sessionScope || "")
      .trim()
      .slice(0, 2_000) || null;
  if (!input.chatId.trim()) throw new Error("chatId is required");
  if (!title) throw new Error("title is required");

  // Mirror pending_questions' per-chat cap and replace the oldest request if
  // stale UI state ever leaves more than one entry behind.
  const db = getDatabase();
  const waiting = db
    .prepare(
      `SELECT id FROM pending_approvals WHERE chat_id = ? AND status = 'waiting_for_user' ORDER BY created_at`,
    )
    .all(input.chatId) as Array<{ id: string }>;
  while (waiting.length >= limits.maxApprovalsPerChat) {
    const oldest = waiting.shift();
    if (oldest)
      db.prepare("DELETE FROM pending_approvals WHERE id = ?").run(oldest.id);
  }

  const approvalId = randomUUID();
  const timestamp = iso();
  db.prepare(
    `INSERT INTO pending_approvals
      (id, job_id, chat_id, owner_id, status, title, command, files_json, created_at, heartbeat_at, session_scope, version)
     VALUES (?, ?, ?, ?, 'waiting_for_user', ?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    approvalId,
    input.jobId?.trim() || null,
    input.chatId,
    input.ownerId?.trim() || null,
    title,
    command ?? null,
    JSON.stringify(files),
    timestamp,
    timestamp,
    sessionScope,
  );
  return { approvalId };
}

export function resolveApproval(
  approvalId: string,
  decision: ApprovalDecision,
  userId?: string,
  version?: number,
): {
  jobId: string;
  chatId: string;
  decision: ApprovalDecision;
  sessionScope?: string;
} | null {
  if (!approvalId.trim() || !normalizeDecision(decision)) return null;
  return transaction(() => {
    const db = getDatabase();
    const raw = selectOne(approvalId);
    const approval = mapApproval(raw);
    if (!approval || (userId && approval.ownerId !== userId)) return null;
    if (approval.status === "resolved") return null;
    if (version !== undefined && version !== approval.version) return null;
    const timestamp = iso();
    const sessionScope =
      decision === "allow-session"
        ? approval.sessionScope?.trim() || `${approvalId}:session`
        : null;
    const changed = db
      .prepare(
        `UPDATE pending_approvals
       SET status = 'resolved', resolved_at = ?, decision = ?, session_scope = ?, version = version + 1
       WHERE id = ? AND status = 'waiting_for_user' AND version = ?`,
      )
      .run(timestamp, decision, sessionScope, approvalId, approval.version);
    if (!changed.changes) return null;
    return {
      ...(approval.jobId ? { jobId: approval.jobId } : { jobId: "" }),
      chatId: approval.chatId,
      decision,
      ...(sessionScope ? { sessionScope } : {}),
    };
  });
}

export function heartbeatApproval(approvalId: string) {
  const changed = getDatabase()
    .prepare(
      `UPDATE pending_approvals
     SET heartbeat_at = ?
     WHERE id = ? AND status = 'waiting_for_user'`,
    )
    .run(iso(), approvalId);
  return Boolean(changed.changes);
}

export function getApproval(
  approvalId: string,
  userId?: string,
): PendingApproval | null {
  const approval = mapApproval(selectOne(approvalId));
  if (!approval || (userId && approval.ownerId !== userId)) return null;
  return approval;
}

export function getPendingApprovalForChat(
  chatId: string,
  userId?: string,
): PendingApproval | null {
  const rows = getDatabase()
    .prepare(
      `SELECT id, job_id as jobId, chat_id as chatId, owner_id as ownerId, status, title, command,
            files_json as filesJson, created_at as createdAt, heartbeat_at as heartbeatAt,
            resolved_at as resolvedAt, decision, session_scope as sessionScope, version
     FROM pending_approvals
     WHERE chat_id = ? AND (? IS NULL OR owner_id = ?) AND status = 'waiting_for_user'
     ORDER BY created_at DESC LIMIT 1`,
    )
    .all(chatId, userId ?? null, userId ?? null);
  return rows.length ? mapApproval(rows[0]) : null;
}

function expireWaitingApproval(
  approval: PendingApproval,
  db: ReturnType<typeof getDatabase>,
  reason: string,
) {
  const changed = db
    .prepare(
      `UPDATE pending_approvals
     SET status = 'resolved', resolved_at = ?, decision = 'deny', session_scope = NULL, version = version + 1
     WHERE id = ? AND status = 'waiting_for_user' AND version = ?`,
    )
    .run(iso(), approval.approvalId, approval.version);
  return changed.changes
    ? {
        jobId: approval.jobId || "",
        chatId: approval.chatId,
        decision: "deny" as const,
        reason,
      }
    : null;
}

export function expireApproval(
  approvalId: string,
  userId?: string,
  reason = "The approval timed out.",
) {
  const approval = getApproval(approvalId, userId);
  if (!approval || approval.status !== "waiting_for_user") return null;
  const expired = expireWaitingApproval(approval, getDatabase(), reason);
  return expired;
}

export function expireApprovals(now = Date.now()) {
  const cutoff = new Date(now - approvalLimits().timeoutMs).toISOString();
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT id, job_id as jobId, chat_id as chatId, owner_id as ownerId, status, title, command,
            files_json as filesJson, created_at as createdAt, heartbeat_at as heartbeatAt,
            resolved_at as resolvedAt, decision, session_scope as sessionScope, version
     FROM pending_approvals
     WHERE status = 'waiting_for_user'
       AND COALESCE(heartbeat_at, created_at) <= ?`,
    )
    .all(cutoff) as unknown[];
  return rows
    .map((row) => {
      const approval = mapApproval(row);
      return approval
        ? expireWaitingApproval(approval, db, "The approval timed out.")
        : null;
    })
    .filter(Boolean);
}
