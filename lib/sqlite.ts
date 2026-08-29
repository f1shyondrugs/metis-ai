import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID, pbkdf2Sync, randomBytes } from "node:crypto";
import { config } from "@/lib/config";

const dataDir = config.dataDir;
export const databasePath = config.databasePath;

let database: DatabaseSync | undefined;

function json<T>(file: string, fallback: T): T {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}

function atomicJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.migration`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  return `${salt}:${pbkdf2Sync(password, salt, 120_000, 32, "sha256").toString("hex")}`;
}

function syncLegacyMemories(db: DatabaseSync, memoriesPath: string, ownerId?: string) {
  const insertMemory = db.prepare(
    "INSERT OR IGNORE INTO memories (id, owner_id, data, updated_at) VALUES (?, ?, ?, ?)",
  );
  for (const memory of json<Array<Record<string, unknown>>>(memoriesPath, [])) {
    if (typeof memory.id === "string") {
      insertMemory.run(
        memory.id,
        ownerId ?? null,
        JSON.stringify(memory),
        typeof memory.updatedAt === "string" ? memory.updatedAt : new Date().toISOString(),
      );
    }
  }
}

function migrateLegacy(db: DatabaseSync) {
  const hasMigration = db.prepare("SELECT value FROM meta WHERE key = 'json_migrated'").get();
  const userCount = Number((db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number }).count);
  const ownerMigration = db.prepare("SELECT value FROM meta WHERE key = 'legacy_owner_assigned'").get();
  const usersPath = path.join(dataDir, "users.json");
  const sessionsPath = path.join(dataDir, "sessions.json");
  const chatsDir = path.join(dataDir, "chats");
  const memoriesPath = path.join(dataDir, "memories.json");
  const settingsPath = path.join(dataDir, "settings.json");
  if (hasMigration && userCount > 0 && ownerMigration) {
    // SQLite is canonical after migration. Do not re-import the legacy JSON
    // snapshot on every process initialization, otherwise deleted memories
    // would be resurrected on the next reload.
    return;
  }

  const users = json<Array<{ id: string; username: string; passwordHash: string; createdAt: string }>>(
    usersPath,
    [],
  );
  if (
    !users.length &&
    process.env.CHAT_PASSWORD?.trim() &&
    !process.env.METIS_AI_BOOTSTRAP_PASSWORD
  ) {
    users.push({
      id: randomUUID(),
      username: config.chatUsername,
      passwordHash: hashPassword(process.env.CHAT_PASSWORD.trim()),
      createdAt: new Date().toISOString(),
    });
  }
  const initialUser = users[0] || (db.prepare(
    "SELECT id, username, password_hash as passwordHash, created_at as createdAt FROM users ORDER BY created_at ASC LIMIT 1",
  ).get() as { id: string; username: string; passwordHash: string; createdAt: string } | undefined);
  const insertUser = db.prepare(
    "INSERT OR IGNORE INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)",
  );
  for (const user of users) {
    insertUser.run(user.id, user.username, user.passwordHash, user.createdAt);
  }
  const sessions = json<Array<{ tokenHash: string; userId: string; expiresAt: string }>>(
    sessionsPath,
    [],
  );
  const insertSession = db.prepare(
    "INSERT OR IGNORE INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
  );
  for (const session of sessions) {
    insertSession.run(session.tokenHash, session.userId, session.expiresAt);
  }

  const index = json<Array<Record<string, unknown>>>(path.join(chatsDir, "index.json"), []);
  const insertChat = db.prepare(
    "INSERT OR IGNORE INTO chats (id, owner_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (const entry of index) {
    if (typeof entry.id !== "string") continue;
    const file = path.join(chatsDir, `${entry.id}.json`);
    const chat = json<Record<string, unknown> | null>(file, null);
    if (!chat) continue;
    const ownerId =
      typeof chat.ownerId === "string"
        ? chat.ownerId
        : typeof entry.ownerId === "string"
          ? entry.ownerId
          : initialUser?.id;
    if (ownerId && !chat.ownerId) chat.ownerId = ownerId;
    const createdAt =
      typeof chat.createdAt === "string" ? chat.createdAt : new Date().toISOString();
    const updatedAt =
      typeof chat.updatedAt === "string" ? chat.updatedAt : createdAt;
    insertChat.run(String(chat.id), typeof ownerId === "string" ? ownerId : null, JSON.stringify(chat), createdAt, updatedAt);
  }

  const ownerId = (db.prepare("SELECT id FROM users ORDER BY created_at ASC LIMIT 1").get() as { id?: string } | undefined)?.id;
  syncLegacyMemories(db, memoriesPath, ownerId);
  const settings = json<Record<string, unknown>>(settingsPath, {});
  db.prepare("INSERT OR REPLACE INTO settings (key, owner_id, data) VALUES (?, ?, ?)").run(
    ownerId ? `global:${ownerId}` : "global",
    ownerId ?? null,
    JSON.stringify(settings),
  );
  if (ownerId && !db.prepare("SELECT value FROM meta WHERE key = 'legacy_owner_assigned'").get()) {
    const legacyChats = db.prepare("SELECT id, data FROM chats WHERE owner_id IS NULL").all() as Array<{ id: string; data: string }>;
    const assign = db.prepare("UPDATE chats SET owner_id = ?, data = ? WHERE id = ?");
    for (const row of legacyChats) {
      try {
        const chat = JSON.parse(row.data) as Record<string, unknown>;
        chat.ownerId = ownerId;
        assign.run(ownerId, JSON.stringify(chat), row.id);
      } catch {
        assign.run(ownerId, row.data, row.id);
      }
    }
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('legacy_owner_assigned', '1')").run();
  }
  if (ownerId) {
    db.prepare("UPDATE memories SET owner_id = ? WHERE owner_id IS NULL").run(ownerId);
    db.prepare("UPDATE settings SET owner_id = ? WHERE owner_id IS NULL").run(ownerId);
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('json_migrated', '1')").run();

  // Keep a readable backup marker so operators can verify that migration happened.
  const marker = path.join(dataDir, "sqlite-migration.json");
  if (!existsSync(marker)) {
    atomicJson(marker, { migratedAt: new Date().toISOString(), databasePath });
  }
}

export function getDatabase(): DatabaseSync {
  if (database) return database;
  mkdirSync(path.dirname(databasePath), { recursive: true });
  database = new DatabaseSync(databasePath, { timeout: 10_000 });
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -32768;
    PRAGMA busy_timeout = 10000;
    PRAGMA wal_autocheckpoint = 1000;
    PRAGMA journal_size_limit = 67108864;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS user_workspace_access (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      workspace_root TEXT NOT NULL,
      os_username TEXT,
      uid INTEGER,
      gid INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS user_workspace_access_root
      ON user_workspace_access(workspace_root);
    CREATE TABLE IF NOT EXISTS user_model_permissions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, model_id)
    );
    CREATE INDEX IF NOT EXISTS user_model_permissions_model
      ON user_model_permissions(model_id);
    CREATE TABLE IF NOT EXISTS provider_connections (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_key TEXT NOT NULL,
      slug TEXT NOT NULL,
      label TEXT NOT NULL,
      auth_type TEXT NOT NULL,
      base_url TEXT,
      config TEXT NOT NULL DEFAULT '{}',
      secret_blob TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      last_checked_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_id, slug)
    );
    CREATE INDEX IF NOT EXISTS provider_connections_owner
      ON provider_connections(owner_id, enabled, provider_key);
    CREATE TABLE IF NOT EXISTS provider_models (
      connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
      canonical_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT,
      capabilities TEXT NOT NULL DEFAULT '{}',
      discovered_at TEXT NOT NULL,
      PRIMARY KEY (connection_id, canonical_id)
    );
    CREATE INDEX IF NOT EXISTS provider_models_connection
      ON provider_models(connection_id, discovered_at DESC);
    CREATE TABLE IF NOT EXISTS provider_oauth_flows (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
      provider_key TEXT NOT NULL,
      status TEXT NOT NULL,
      auth_url TEXT,
      instructions TEXT,
      manual_code TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS provider_oauth_flows_owner
      ON provider_oauth_flows(owner_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chats_owner_updated ON chats(owner_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS tool_revert_snapshots (
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      tool_id TEXT NOT NULL,
      path TEXT,
      before_text TEXT,
      after_text TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (chat_id, message_id, tool_id)
    );
    CREATE INDEX IF NOT EXISTS tool_revert_snapshots_chat
      ON tool_revert_snapshots(chat_id, message_id);
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_status_created ON jobs(status, updated_at);
    CREATE TABLE IF NOT EXISTS job_leases (
      job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
      worker_id TEXT NOT NULL,
      lease_token TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS job_leases_expiry
      ON job_leases(expires_at);
    CREATE TABLE IF NOT EXISTS capability_manifests (
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (owner_id, run_id, attempt_id)
    );
    CREATE INDEX IF NOT EXISTS capability_manifests_run
      ON capability_manifests(owner_id, run_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
     project_id TEXT,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      mode_id TEXT,
      model_id TEXT,
      extended_model_id TEXT,
      creator TEXT NOT NULL DEFAULT 'user' CHECK (creator IN ('user', 'agent')),
      max_run_minutes INTEGER NOT NULL DEFAULT 1440,
      graph_json TEXT,
      schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('once', 'interval')),
      schedule_value TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'error')),
      next_run_at TEXT,
      last_run_at TEXT,
      last_error TEXT,
      claimed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS automations_due
      ON automations(status, next_run_at, claimed_at);
    CREATE INDEX IF NOT EXISTS automations_owner
      ON automations(owner_id, status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      job_id TEXT,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'error', 'cancelled')),
      trigger_type TEXT NOT NULL DEFAULT 'scheduled' CHECK (trigger_type IN ('scheduled', 'manual')),
      started_at TEXT,
      completed_at TEXT,
      result_preview TEXT,
      error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS automation_runs_automation
      ON automation_runs(automation_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      event TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS run_events_chat_id ON run_events(chat_id, id);
    CREATE INDEX IF NOT EXISTS run_events_chat_job_id ON run_events(chat_id, job_id, id);
    CREATE TABLE IF NOT EXISTS pending_questions (
      question_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
      response TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope, key)
    );
    CREATE INDEX IF NOT EXISTS idempotency_keys_owner
      ON idempotency_keys(owner_id, chat_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
      workspace_id TEXT,
      scope TEXT NOT NULL CHECK (scope IN ('global', 'chat', 'workspace')),
      data TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notes_scope
      ON notes(owner_id, scope, chat_id, workspace_id, archived, updated_at DESC);
    CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS projects_owner ON projects(owner_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS project_files (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime_type TEXT,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS project_files_project ON project_files(project_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS note_activities (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS note_activities_note
      ON note_activities(note_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS session_snapshots (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      schema_version INTEGER NOT NULL,
      checkpoint TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS session_snapshots_chat
      ON session_snapshots(chat_id, owner_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS voice_jobs (
      id TEXT PRIMARY KEY,
      owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS voice_jobs_owner
      ON voice_jobs(owner_id, chat_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS remote_clients (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'offline',
      os TEXT,
      architecture TEXT,
      version TEXT,
      hostname TEXT,
      address TEXT,
      capabilities TEXT NOT NULL DEFAULT '[]',
      policy TEXT NOT NULL DEFAULT '{"mode":"full_access","allowlist":[]}',
      last_seen_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS remote_clients_owner
      ON remote_clients(owner_id, revoked_at, updated_at DESC);
    CREATE TABLE IF NOT EXISTS remote_client_credentials (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES remote_clients(id) ON DELETE CASCADE,
      secret_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS remote_client_credentials_client
      ON remote_client_credentials(client_id, revoked_at);
    CREATE TABLE IF NOT EXISTS remote_enrollment_tokens (
      token_hash TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS remote_enrollment_tokens_owner
      ON remote_enrollment_tokens(owner_id, expires_at);
    CREATE TABLE IF NOT EXISTS remote_audit (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_id TEXT REFERENCES remote_clients(id) ON DELETE SET NULL,
      source TEXT NOT NULL,
      action TEXT NOT NULL,
      request_data TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS remote_audit_owner
      ON remote_audit(owner_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS remote_approval_requests (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL REFERENCES remote_clients(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      args_hash TEXT NOT NULL,
      request_data TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL,
      run_id TEXT,
      tool_call_id TEXT,
      expires_at TEXT NOT NULL,
      approved_at TEXT,
      consumed_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS remote_approval_requests_owner
      ON remote_approval_requests(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS remote_approval_requests_lookup
      ON remote_approval_requests(owner_id, client_id, action, args_hash, expires_at);
    CREATE TABLE IF NOT EXISTS browser_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS browser_history_chat
      ON browser_history(owner_id, chat_id, ts DESC);
  `);
  for (const statement of [
    "ALTER TABLE memories ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE CASCADE",
    "ALTER TABLE settings ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE CASCADE",
    "ALTER TABLE provider_oauth_flows ADD COLUMN user_code TEXT",
    "ALTER TABLE pending_questions ADD COLUMN run_id TEXT",
    "ALTER TABLE pending_questions ADD COLUMN job_id TEXT",
    "ALTER TABLE pending_questions ADD COLUMN version INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE pending_questions ADD COLUMN expires_at TEXT",
    "ALTER TABLE pending_questions ADD COLUMN status TEXT NOT NULL DEFAULT 'waiting_for_user'",
    "ALTER TABLE pending_questions ADD COLUMN heartbeat_at TEXT",
    "ALTER TABLE automations ADD COLUMN mode_id TEXT",
    "ALTER TABLE automations ADD COLUMN model_id TEXT",
    "ALTER TABLE automations ADD COLUMN extended_model_id TEXT",
    "ALTER TABLE automations ADD COLUMN creator TEXT NOT NULL DEFAULT 'user'",
    "ALTER TABLE automations ADD COLUMN max_run_minutes INTEGER NOT NULL DEFAULT 1440",
    "ALTER TABLE automations ADD COLUMN graph_json TEXT",
    "ALTER TABLE automations ADD COLUMN project_id TEXT",
    "ALTER TABLE automation_runs ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'scheduled'",
    "ALTER TABLE provider_models ADD COLUMN context_window INTEGER",
    "ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE automation_runs ADD COLUMN manual INTEGER NOT NULL DEFAULT 0",
  ]) {
    try {
      database.exec(statement);
    } catch {
      // Columns already exist on databases created with the account-aware schema.
    }
  }
  database.exec(
    "CREATE INDEX IF NOT EXISTS pending_questions_status_expiry ON pending_questions(status, expires_at)",
  );
  try {
    database.prepare(
      `UPDATE remote_clients
       SET policy = json_set(policy, '$.mode', 'full_access')
       WHERE json_extract(policy, '$.mode') = 'approval_required'`,
    ).run();
  } catch {
    // JSON1 is always present on supported Node SQLite builds; ignore if the table is mid-migration.
  }
  migrateLegacy(database);
  database.prepare(
    "INSERT OR IGNORE INTO meta (key, value) VALUES ('provider_connections_schema', '1')",
  ).run();
  database.prepare(
    `INSERT OR IGNORE INTO user_model_permissions (user_id, model_id, created_at)
     SELECT id, '*', ? FROM users`,
  ).run(new Date().toISOString());
  database.prepare(
    "INSERT OR IGNORE INTO meta (key, value) VALUES ('shared_context_schema', '2')",
  ).run();
  const accessTimestamp = new Date().toISOString();
  database.prepare(
    `INSERT OR IGNORE INTO user_workspace_access
       (user_id, workspace_root, created_at, updated_at)
     SELECT id, ?, ?, ? FROM users`,
  ).run(config.agentCwd, accessTimestamp, accessTimestamp);
  const adminCount = Number(
    (database.prepare("SELECT COUNT(*) as count FROM users WHERE is_admin = 1").get() as { count: number }).count,
  );
  if (adminCount === 0) {
    database.prepare(
      `UPDATE users SET is_admin = 1
       WHERE id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)`,
    ).run();
  }
  return database;
}

export function isSqliteBusyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(message);
}

export function isSqliteForeignKeyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /FOREIGN KEY constraint failed/i.test(message);
}

export function withSqliteRetry<T>(fn: () => T, attempts = 8): T {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      if (!isSqliteBusyError(error) || attempt === attempts) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(250, 20 * attempt));
    }
  }
  throw lastError;
}

export function transaction<T>(fn: () => T): T {
  return withSqliteRetry(() => {
    const db = getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The connection may already have rolled back after a busy lock.
      }
      throw error;
    }
  });
}

export function parseData<T>(row: unknown): T | null {
  if (!row || typeof row !== "object" || !("data" in row)) return null;
  try {
    return JSON.parse(String((row as { data: unknown }).data)) as T;
  } catch {
    return null;
  }
}
