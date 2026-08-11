import { MCPClient } from "./client.js";
import { registry } from "../tools/index.js";
import type { ToolGroup } from "../tools/types.js";
import type { McpServerConfig } from "../config/loader.js";

export type McpServerStatus = "connected" | "failed" | "reconnecting" | "starting";

interface ToolSnapshot {
  name: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpServerStatusEntry {
  name: string;
  status: McpServerStatus;
  toolCount: number;
  /** Present when the server failed to start; naming the reason (e.g. blocked by strictMcpConfig). */
  error?: string;
}

/**
 * Commands an MCP server may be launched from when `strictMcpConfig` is enabled.
 * Compared against the basename of `command`, case-sensitively.
 */
const ALLOWED_MCP_COMMANDS = new Set([
  "npx",
  "node",
  "python3",
  "python",
  "uvx",
  "uv",
  "bun",
  "deno",
  "go",
  "java",
]);

function basename(command: string): string {
  const parts = command.split(/[\\/]/);
  return parts[parts.length - 1] || command;
}

const toolSnapshots = new Map<string, ToolSnapshot[]>();
const statusMap = new Map<string, McpServerStatus>();
const errorMap = new Map<string, string>();
const clientsMap = new Map<string, MCPClient>();
let serverConfigsMap = new Map<string, McpServerConfig>();
let strictMcpConfig = false;

export function getServerConfigs(): Record<string, McpServerConfig> {
  return Object.fromEntries(serverConfigsMap);
}

export function getMCPServerStatuses(): McpServerStatusEntry[] {
  const entries: McpServerStatusEntry[] = [];
  for (const [name, status] of statusMap) {
    const tools = toolSnapshots.get(name) ?? [];
    const error = errorMap.get(name);
    entries.push({ name, status, toolCount: tools.length, ...(error ? { error } : {}) });
  }
  return entries;
}

export function getMCPServerTools(serverName: string): ToolSnapshot[] {
  return toolSnapshots.get(serverName) ?? [];
}

export async function reconnectMCPServer(name: string, config: McpServerConfig): Promise<void> {
  statusMap.set(name, "reconnecting");
  errorMap.delete(name);

  const staleClient = clientsMap.get(name);
  if (staleClient) {
    staleClient.disconnect();
    clientsMap.delete(name);
  }

  if (strictMcpConfig) {
    const cmd = basename(config.command);
    if (!ALLOWED_MCP_COMMANDS.has(cmd)) {
      const allowed = [...ALLOWED_MCP_COMMANDS].join(", ");
      const msg =
        `blocked by strictMcpConfig: command "${config.command}" ` +
        `(basename "${cmd}") is not in the allowlist {${allowed}}. ` +
        `To allow it, set "strictMcpConfig": false in settings.`;
      statusMap.set(name, "failed");
      errorMap.set(name, msg);
      process.stderr.write(`  [mcp] ${name}: ${msg}\n`);
      return;
    }
  }

  try {
    const client = new MCPClient();
    await client.connect(config.command, config.args || [], config.env);
    clientsMap.set(name, client);

    const tools = await client.listTools();
    toolSnapshots.set(name, tools.map(t => ({ name: t.name, inputSchema: t.inputSchema as Record<string, unknown> | undefined })));

    for (const tool of tools) {
      const namespacedName = `mcp__${name}__${tool.name}`;
      registry.register({
        def: {
          name: namespacedName,
          description: tool.description || `MCP tool from ${name}: ${tool.name}`,
          parameters: tool.inputSchema
            ? { type: "object", properties: tool.inputSchema.properties ?? {}, required: tool.inputSchema.required ?? [] }
            : { type: "object", properties: {}, required: [] },
        },
        handler: async (args) => {
          try {
            const result = await client.callTool(tool.name, args);
            const content = result.content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n");
            return result.isError
              ? { content, error: content }
              : { content };
          } catch (err) {
            return { content: "", error: (err as Error).message };
          }
        },
        groups: ["mcp", name] as ToolGroup[],
      });
    }

    statusMap.set(name, "connected");
  } catch (err) {
    statusMap.set(name, "failed");
    errorMap.set(name, (err as Error).message);
    process.stderr.write(`  [mcp] ${name}: connection failed — ${(err as Error).message}\n`);
  }
}

export async function connectMCPServers(
  servers: Record<string, McpServerConfig>,
  options?: { strictMcpConfig?: boolean },
): Promise<void> {
  strictMcpConfig = options?.strictMcpConfig ?? false;
  for (const [name, config] of Object.entries(servers)) {
    serverConfigsMap.set(name, config);
    statusMap.set(name, "starting");
    await reconnectMCPServer(name, config);
  }
}

export function disconnectAllMCPServers(): void {
  for (const client of clientsMap.values()) {
    client.disconnect();
  }
  clientsMap.clear();
}
