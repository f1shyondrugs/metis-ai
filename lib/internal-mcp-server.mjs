import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Server,
  StdioServerTransport,
  dispatchGatewayTool,
  visibleToolsForContext,
} from "../packages/mcp-gateway/index.mjs";

const context = {
  chatId: process.env.MCP_CHAT_ID || undefined,
  userId: process.env.MCP_USER_ID || undefined,
  jobId: process.env.MCP_JOB_ID || undefined,
  incognito: process.env.MCP_INCOGNITO === "1",
  automation: process.env.MCP_AUTOMATION === "1",
  modeId: process.env.MCP_MODE_ID || undefined,
  runtimeMode: process.env.AI_CHAT_RUNTIME_MODE || undefined,
  modePolicy: process.env.MCP_MODE_POLICY || undefined,
  compressionEnabled: process.env.MCP_COMPRESSION_ENABLED === "1",
  compressionMode: process.env.MCP_COMPRESSION_MODE || "stacked",
  compressionToolResults: process.env.MCP_COMPRESSION_TOOL_RESULTS !== "0",
  uid: Number(process.env.MCP_OS_UID) || undefined,
  gid: Number(process.env.MCP_OS_GID) || undefined,
  osUsername: process.env.MCP_OS_USERNAME || undefined,
  workspaceRoot: process.env.MCP_AGENT_CWD || undefined,
  allowRoot: process.env.MCP_ALLOW_ROOT_AGENTS === "1",
  isHostAdmin: process.env.MCP_IS_HOST_ADMIN === "1",
  capabilityManifest: process.env.MCP_CAPABILITY_MANIFEST || undefined,
  capabilityHash: process.env.MCP_CAPABILITY_HASH || undefined,
};

const server = new Server(
  { name: `${process.env.APP_NAME?.trim() || "Metis AI"} internal MCP`, version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions:
      `This is the built-in MCP server for ${process.env.APP_NAME?.trim() || "Metis AI"}. It exposes the configured local gateway tool catalog.`,
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: visibleToolsForContext(context) }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const result = await dispatchGatewayTool(
    request.params.name,
    request.params.arguments || {},
    { context: { ...context, transport: "internal" } },
  );
  return result;
});

const transport = new StdioServerTransport();
await server.connect(transport);
