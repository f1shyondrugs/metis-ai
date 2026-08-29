import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import {
  normalizeClaims,
  evaluateClaim,
  recordVerified,
  ledgerSummary,
  compactReport,
} from "../lib/mcp-core/work-ledger.mjs";
import { CORE_MCP_TOOL_ALLOWLIST } from "../lib/mcp-bridge";

test("verify_work + ledger tools are declared in the bridge allowlist", () => {
  assert.ok(CORE_MCP_TOOL_ALLOWLIST.includes("verify_work"));
  assert.ok(CORE_MCP_TOOL_ALLOWLIST.includes("ledger_review"));
  assert.ok(CORE_MCP_TOOL_ALLOWLIST.includes("audio_fingerprint"));
});

test("normalizeClaims validates shape and enforces caps", () => {
  const { claims, errors } = normalizeClaims([
    { label: "tests pass", command: "pnpm test", expect: ["pass"], reject: ["fail"], timeout: 90 },
    { label: "", command: "ls" },
    { command: "ls" },
    "junk",
    { label: "big", command: "ls", timeout: 9999 },
  ]);
  assert.equal(errors.length, 3);
  assert.equal(claims.length, 2);
  assert.equal(claims[0]?.expect?.length, 1);
  assert.equal(claims[1]?.timeout, 120); // clamped
});

test("evaluateClaim verifies against real runShell result shape", () => {
  const claim = { label: "echo", command: "echo hello", expect: ["hello"], reject: ["boom"], target: "server" };
  const ok = evaluateClaim(claim, { exit_code: 0, stdout: "hello\n", stderr: "" });
  assert.equal(ok.verified, true);
  assert.deepEqual(ok.matched, ["hello"]);
  const badExit = evaluateClaim(claim, { exit_code: 1, stdout: "hello\n", stderr: "" });
  assert.equal(badExit.verified, false);
  const missingMarker = evaluateClaim(claim, { exit_code: 0, stdout: "world\n", stderr: "" });
  assert.equal(missingMarker.verified, false);
  assert.deepEqual(missingMarker.missing, ["hello"]);
  const rejectedMarker = evaluateClaim(claim, { exit_code: 0, stdout: "hello boom\n", stderr: "" });
  assert.equal(rejectedMarker.verified, false);
  assert.deepEqual(rejectedMarker.foundRejected, ["boom"]);
});

test("ledger records and reviews entries per job context", () => {
  const context = { jobId: "job-test-1", chatId: "chat-1" };
  const entries = [
    { label: "a", command: "true", target: "server", verified: true, exitCode: 0 },
    { label: "b", command: "false", target: "server", verified: false, exitCode: 1 },
  ];
  const record = recordVerified(undefined, context, entries);
  assert.ok(record);
  assert.equal(record.entries.length, 2);
  const summary = ledgerSummary(context);
  assert.equal(summary.exists, true);
  assert.equal(summary.verified, 1);
  assert.equal(summary.failed, 1);
  const other = ledgerSummary({ jobId: "job-test-2" });
  assert.equal(other.exists, false);
});

test("compactReport summarizes verification outcome", () => {
  const report = compactReport([
    { label: "ok", command: "true", verified: true, exitCode: 0 },
    { label: "bad", command: "false", verified: false, exitCode: 1, missing: ["x"] },
  ]);
  assert.equal(report.allVerified, false);
  assert.equal(report.verified, 1);
  assert.match(report.report, /VERIFIED {2}ok/);
  assert.match(report.report, /FAILED {2}bad/);
});

// ---------------------------------------------------------------------------
// E2E over the real stdio MCP server (top-level await in gateway-core.mjs
// prevents direct CJS import in tests — the server is spawned instead).
// ---------------------------------------------------------------------------

type Line = { jsonrpc: string; id?: number; result?: unknown; error?: unknown };

function startGateway() {
  const child = spawn("node", ["--experimental-vm-modules", "lib/internal-mcp-server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, AI_CHAT_INTERNAL_ORIGIN: "http://127.0.0.1:4000" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const pending = new Map<number, (value: Line) => void>();
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as Line;
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      } catch {
        /* non-JSON line (stderr-like noise) */
      }
    }
  });
  const collected: string[] = [];
  child.stderr.on("data", (d) => collected.push(d.toString()));
  let nextId = 1;
  const call = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Line>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method} (stderr: ${collected.slice(-5).join("").slice(0, 300)})`));
        }
      }, 30_000);
    });
  const notify = (method: string) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  return { child, call, notify };
}

test("stdio gateway exposes and executes the new tools end-to-end", async () => {
  const gateway = startGateway();
  try {
    const init = await gateway.call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "work-ledger-test", version: "1.0" },
    });
    assert.ok(init.result, "initialize must succeed");
    gateway.notify("notifications/initialized");

    const list = await gateway.call("tools/list");
    const tools = (list.result as { tools?: Array<{ name: string }> }).tools || [];
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes("verify_work"), "verify_work must be listed");
    assert.ok(names.includes("ledger_review"), "ledger_review must be listed");
    assert.ok(names.includes("audio_fingerprint"), "audio_fingerprint must be listed");

    const verify = await gateway.call("tools/call", {
      name: "verify_work",
      arguments: {
        claims: [
          { label: "echo marker works", command: "echo proof-of-work-ok", expect: ["proof-of-work-ok"] },
          { label: "missing marker fails", command: "echo something-else", expect: ["never-appears"] },
        ],
      },
    });
    const verifyText = (verify.result as { content: Array<{ text: string }> }).content[0].text;
    const payload = JSON.parse(verifyText);
    assert.equal(payload.total, 2);
    assert.equal(payload.verified, 1);
    assert.equal(payload.allVerified, false);
    assert.equal(payload.results[0].verified, true);
    assert.equal(payload.results[1].verified, false);

    const stats = await gateway.call("tools/call", {
      name: "audio_fingerprint",
      arguments: { action: "stats" },
    });
    const statsText = (stats.result as { content: Array<{ text: string }> }).content[0].text;
    const statsPayload = JSON.parse(statsText);
    assert.equal(statsPayload.ok, true);
    assert.equal(typeof statsPayload.tracks, "number");

    const invalid = await gateway.call("tools/call", {
      name: "audio_fingerprint",
      arguments: { action: "match" },
    });
    const invalidResult = invalid.result as { isError?: boolean; content?: Array<{ text: string }> };
    assert.ok(
      invalidResult?.isError || invalid.error,
      "match without audio must fail (isError or JSON-RPC error)",
    );
    const invalidText = invalidResult?.content?.[0]?.text || JSON.stringify(invalid.error || {});
    assert.match(invalidText, /audio is required/i);
  } finally {
    gateway.child.kill();
  }
});
