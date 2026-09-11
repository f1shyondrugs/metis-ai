import { cookies } from "next/headers";
import {
  createHash,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { getDatabase } from "@/lib/sqlite";
import { safeEqual } from "@/lib/security";
import { provisionAccountAccess } from "@/lib/user-access";

export const CHAT_COOKIE = "ai_chat_auth";
export const CHAT_USER_COOKIE = "ai_chat_user";

type User = {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
};

type Session = {
  tokenHash: string;
  userId: string;
  expiresAt: string;
};

const sessionMaxAge = 60 * 60 * 24 * 30;

function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  return `${salt}:${pbkdf2Sync(password, salt, 120_000, 32, "sha256").toString("hex")}`;
}

function verifyPassword(password: string, encoded: string) {
  const [salt, digest] = encoded.split(":");
  if (!salt || !digest) return false;
  const actual = pbkdf2Sync(password, salt, 120_000, 32, "sha256").toString("hex");
  return safeEqual(actual, digest);
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function users() {
  return getDatabase()
    .prepare("SELECT id, username, password_hash as passwordHash, created_at as createdAt FROM users")
    .all() as unknown as User[];
}

export function createUser(username: string, password: string) {
  const normalized = username.trim();
  if (!normalized || !password) throw new Error("Username and password are required.");
  const user = {
    id: randomUUID(),
    username: normalized,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  getDatabase().prepare(
    "INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)",
  ).run(user.id, user.username, user.passwordHash, user.createdAt);
  provisionAccountAccess(user.id, user.username);
  return user;
}

export function getChatPassword(): string {
  return process.env.CHAT_PASSWORD?.trim() || "";
}

export function passwordMatches(provided: string | null | undefined): boolean {
  const expected = getChatPassword();
  if (!expected || !provided) return false;
  return safeEqual(provided, expected);
}

export async function isAuthenticated(req?: Request): Promise<boolean> {
  return Boolean(await getAuthenticatedUser(req));
}

export async function getAuthenticatedUser(req?: Request): Promise<User | null> {
  const legacyPassword = req?.headers.get("x-chat-password");
  const legacyUser = req?.headers.get("x-chat-username")?.trim();
  const migrated = users();
  if (
    process.env.CHAT_LEGACY_HEADER_AUTH === "true" &&
    legacyPassword &&
    passwordMatches(legacyPassword)
  ) {
    // Off by default. The shared password plus a caller-chosen username is an
    // impersonation path; keep it only as an explicit migration bridge.
    if (!legacyUser) return null;
    return migrated.find((user) => user.username === legacyUser) ?? null;
  }
  const requestCookie = req?.headers.get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${CHAT_COOKIE}=`))
    ?.slice(CHAT_COOKIE.length + 1);
  const token = req
    ? requestCookie
    : (await cookies())?.get(CHAT_COOKIE)?.value;
  if (!token) return null;
  const session = getDatabase().prepare(
    `SELECT s.user_id as userId, s.expires_at as expiresAt,
            u.id, u.username, u.password_hash as passwordHash, u.created_at as createdAt
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
  ).get(tokenHash(token)) as (Session & User) | undefined;
  return session && new Date(session.expiresAt).getTime() > Date.now() ? session : null;
}

export async function getAuthenticatedUserId(req?: Request): Promise<string | null> {
  return (await getAuthenticatedUser(req))?.id ?? null;
}

export function authenticateUser(username: string, password: string) {
  const user = users().find(
    (candidate) => candidate.username === username.trim() && verifyPassword(password, candidate.passwordHash),
  );
  if (!user) return null;
  const token = randomBytes(32).toString("base64url");
  getDatabase().prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
  ).run(
    tokenHash(token),
    user.id,
    new Date(Date.now() + sessionMaxAge * 1000).toISOString(),
  );
  return { user, token, maxAge: sessionMaxAge };
}
