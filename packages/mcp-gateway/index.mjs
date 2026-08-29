/**
 * Public module boundary for the AIO agent platform's MCP gateway.
 *
 * The implementation remains in lib/mcp-core while consumers migrate to this
 * package boundary. Keeping this adapter small makes the runtime import stable
 * for the Next.js app, worker, and future standalone gateway process.
 */
export {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Server,
  StdioServerTransport,
  childCacheKey,
  dispatchGatewayTool,
  modeToolCategory,
  runtimeModeRequiresApproval,
  shouldAutoApprove,
  removeMcpServer,
  tools,
  visibleToolsForContext,
} from "../../lib/mcp-core/gateway-core.mjs";
