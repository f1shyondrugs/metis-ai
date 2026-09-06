import {
  appendRemoteAudit,
  authenticateRemoteClient,
  authorizeRemoteAction,
  getRemoteClient,
  markRemoteClientOffline,
  markRemoteClientSeen,
  consumeRemoteApproval,
  createRemoteApproval,
  RemoteApprovalRequiredError,
  type RemoteAction,
} from "@/lib/remote-clients";

type SocketLike = {
  readyState: number;
  send: (data: string) => void;
  on: (event: "message" | "close" | "error", callback: (value?: unknown) => void) => void;
  close: () => void;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const OPEN = 1;
type GatewayState = {
  connections: Map<string, { socket: SocketLike; ownerId: string; pending: Map<string, Pending> }>;
  events: Map<string, Array<Record<string, unknown>>>;
};
const processGlobal = globalThis as typeof globalThis & { __metisRemoteGateway?: GatewayState };
const gatewayState = processGlobal.__metisRemoteGateway || {
  connections: new Map<string, { socket: SocketLike; ownerId: string; pending: Map<string, Pending> }>(),
  events: new Map<string, Array<Record<string, unknown>>>(),
};
processGlobal.__metisRemoteGateway = gatewayState;
const connections = gatewayState.connections;

export function disconnectRemoteClient(clientId: string) {
  const connection = connections.get(clientId);
  if (!connection) return;
  connection.socket.close();
  connections.delete(clientId);
}

export function authenticateClientMessage(message: unknown) {
  if (!message || typeof message !== "object") return null;
  const data = message as Record<string, unknown>;
  if (data.type !== "auth" || typeof data.clientId !== "string" || typeof data.credential !== "string") return null;
  return authenticateRemoteClient(data.clientId, data.credential);
}

export function attachRemoteClient(socket: SocketLike, clientId: string, ownerId: string, address?: string) {
  connections.get(clientId)?.socket.close();
  const pending = new Map<string, Pending>();
  connections.set(clientId, { socket, ownerId, pending });
  markRemoteClientSeen(clientId, address);
  socket.on("message", (raw: unknown) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === "heartbeat") {
      markRemoteClientSeen(clientId, address);
      socket.send(JSON.stringify({ type: "heartbeat_ack", timestamp: Date.now() }));
      return;
    }
    if (message.type === "event" && typeof message.sessionId === "string") {
      const events = gatewayState.events.get(message.sessionId) || [];
      events.push(message);
      gatewayState.events.set(message.sessionId, events.slice(-200));
      return;
    }
    if (message.type !== "response" || typeof message.requestId !== "string") return;
    const item = pending.get(message.requestId);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(message.requestId);
    if (message.ok === false) item.reject(new Error(typeof message.error === "string" ? message.error : "Remote client request failed"));
    else item.resolve(message.result);
  });
  socket.on("close", () => {
    if (connections.get(clientId)?.socket !== socket) return;
    connections.delete(clientId);
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("Remote client disconnected"));
    }
    markRemoteClientOffline(clientId);
  });
}

export function requestRemoteClient(input: {
  clientId: string;
  ownerId: string;
  action: RemoteAction;
  params?: Record<string, unknown>;
  source?: "user" | "agent";
  approvalId?: string;
  runId?: string;
  toolCallId?: string;
  timeoutMs?: number;
}) {
  const client = getRemoteClient(input.clientId, input.ownerId);
  if (!client) throw new Error("Remote client not found");
  const authorization = authorizeRemoteAction(client, input.action, input.params);
  if (!authorization.allowed) {
    appendRemoteAudit({
      ownerId: input.ownerId,
      clientId: input.clientId,
      source: input.source || "user",
      action: input.action,
      requestData: redact(input.params),
      status: "denied",
      error: authorization.reason,
    });
    throw new Error(authorization.reason || "Remote action denied");
  }
  if (authorization.requiresApproval) {
    if (!input.approvalId || !consumeRemoteApproval({
      id: input.approvalId,
      ownerId: input.ownerId,
      clientId: input.clientId,
      action: input.action,
      params: input.params,
    })) {
      const approval = createRemoteApproval({
        ownerId: input.ownerId,
        clientId: input.clientId,
        action: input.action,
        params: input.params,
        source: input.source,
        runId: input.runId,
        toolCallId: input.toolCallId,
      });
      throw new RemoteApprovalRequiredError(approval.id);
    }
  }
  const connection = connections.get(input.clientId);
  if (!connection || connection.socket.readyState !== OPEN) throw new Error("Remote client is offline");
  const requestId = crypto.randomUUID();
  const timeoutMs = Math.max(1_000, Math.min(input.timeoutMs || 60_000, 300_000));
  const promise = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.pending.delete(requestId);
      reject(new Error("Remote client request timed out"));
    }, timeoutMs);
    connection.pending.set(requestId, { resolve, reject, timer });
  });
  connection.socket.send(JSON.stringify({
    type: "request",
    requestId,
    action: input.action,
    params: input.params || {},
    timestamp: Date.now(),
  }));
  const send = (action: string, params: Record<string, unknown>) => {
    if (action === input.action && params === input.params) return promise;
    const fallbackId = crypto.randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(fallbackId);
        reject(new Error("Remote client request timed out"));
      }, timeoutMs);
      connection.pending.set(fallbackId, { resolve, reject, timer });
      connection.socket.send(JSON.stringify({
        type: "request",
        requestId: fallbackId,
        action,
        params,
        timestamp: Date.now(),
      }));
    });
  };
  const resultPromise = promise.catch((error) => {
    const legacyAction = input.action === "write_file" || input.action === "edit_file" || input.action === "delete_file";
    const unsupported = error instanceof Error && /unsupported remote action/i.test(error.message);
    if (!legacyAction || !unsupported) throw error;
    return send("execute_command", {
      command: legacyFileCommand(client, input.action, input.params || {}),
    });
  });
  return resultPromise.then((result) => {
    appendRemoteAudit({
      ownerId: input.ownerId,
      clientId: input.clientId,
      source: input.source || "user",
      action: input.action,
      requestData: redact(input.params),
      status: "completed",
    });
    return result;
  }).catch((error) => {
    appendRemoteAudit({
      ownerId: input.ownerId,
      clientId: input.clientId,
      source: input.source || "user",
      action: input.action,
      requestData: redact(input.params),
      status: "error",
      error: error instanceof Error ? error.message : "Remote request failed",
    });
    throw error;
  });
}

export async function collectRemoteClientEvents(sessionId: string, waitMs = 150) {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(waitMs, 1_000))));
  const events = gatewayState.events.get(sessionId) || [];
  gatewayState.events.delete(sessionId);
  return events;
}

function redact(params?: Record<string, unknown>) {
  if (!params) return {};
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [
    key.toLowerCase().includes("secret") || key.toLowerCase().includes("token") ? key : key,
    key.toLowerCase().includes("secret") || key.toLowerCase().includes("token") ? "[redacted]" : typeof value === "string" ? value.slice(0, 2_000) : value,
  ]));
}

function base64(value: unknown) {
  return Buffer.from(String(value ?? ""), "utf8").toString("base64");
}

function legacyFileCommand(client: { os?: string }, action: string, params: Record<string, unknown>) {
  const file = base64(params.path);
  const content = base64(params.content);
  const oldText = base64(params.oldText);
  const newText = base64(params.newText);
  const script = action === "write_file"
    ? `const f=Buffer.from('${file}','base64').toString(),c=Buffer.from('${content}','base64');fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,c)`
    : action === "edit_file"
      ? `const f=Buffer.from('${file}','base64').toString(),o=Buffer.from('${oldText}','base64').toString(),n=Buffer.from('${newText}','base64').toString(),c=fs.readFileSync(f,'utf8'),i=c.indexOf(o);if(i<0)throw Error('oldText was not found');fs.writeFileSync(f,c.slice(0,i)+n+c.slice(i+o.length))`
      : `fs.rmSync(Buffer.from('${file}','base64').toString())`;
  const command = `node -e "const fs=require('fs'),path=require('path');${script}"`;
  return client.os?.toLowerCase().includes("win")
    ? command
    : command;
}
