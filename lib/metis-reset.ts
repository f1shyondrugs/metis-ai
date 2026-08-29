import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";
import { clearStoreCaches } from "@/lib/db-store";
import { getDatabase, transaction } from "@/lib/sqlite";

const RESET_TABLES = [
  "remote_approval_requests",
  "remote_audit",
  "remote_enrollment_tokens",
  "remote_client_credentials",
  "remote_clients",
  "voice_jobs",
  "session_snapshots",
  "note_activities",
  "notes",
  "idempotency_keys",
  "pending_questions",
  "pending_approvals",
  "run_events",
  "automation_runs",
  "automations",
  "capability_manifests",
  "job_leases",
  "jobs",
  "tool_revert_snapshots",
  "chats",
  "provider_oauth_flows",
  "provider_connections",
  "provider_models",
  "browser_history",
  "memories",
  "settings",
  "user_model_permissions",
  "sessions",
] as const;

function removePath(target: string) {
  if (!existsSync(target)) return;
  rmSync(target, { recursive: true, force: true });
}

function clearRuntimeFiles() {
  const stateDir = config.mcpStateDir;
  for (const file of ["registry.json", "workflows.json", "audit.jsonl", "memory.jsonl"]) {
    removePath(path.join(stateDir, file));
  }
  for (const directory of ["artifacts", "browser-profiles", "uploads", "traces", "provider-sessions"]) {
    removePath(path.join(config.dataDir, directory));
  }
  for (const file of ["jobs.json", "memories.json", "settings.json", "sqlite-migration.json"]) {
    removePath(path.join(config.dataDir, file));
  }
  removePath(path.join(config.dataDir, "chats"));
}

export function resetMetisData() {
  const db = getDatabase();
  transaction(() => {
    for (const table of RESET_TABLES) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    for (const table of ["error_logs", "model_signals"]) {
      try {
        db.prepare(`DELETE FROM ${table}`).run();
      } catch {
        // These telemetry tables are created lazily.
      }
    }
    const timestamp = new Date().toISOString();
    db.prepare("UPDATE user_workspace_access SET workspace_root = ?, updated_at = ?").run(config.agentCwd, timestamp);
    db.prepare(
      `INSERT OR IGNORE INTO user_workspace_access (user_id, workspace_root, created_at, updated_at)
       SELECT id, ?, ?, ? FROM users`,
    ).run(config.agentCwd, timestamp, timestamp);
    db.prepare(
      `INSERT OR IGNORE INTO user_model_permissions (user_id, model_id, created_at)
       SELECT id, '*', ? FROM users`,
    ).run(timestamp);
  });
  clearRuntimeFiles();
  clearStoreCaches();
  return { ok: true, onboarding: true, resetAt: new Date().toISOString() };
}
