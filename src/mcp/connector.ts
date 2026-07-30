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
}

const toolSnapshots = new Map<string, ToolSnapshot[]>();
const statusMap = new Map<string, McpServerStatus>();
let serverConfigsMap = new Map<string, McpServerConfig>();

export function getServerConfigs(): Record<string, McpServerConfig> {
  return Object.fromEntries(serverConfigsMap);
}

export function getMCPServerStatuses(): McpServerStatusEntry[] {
  const entries: McpServerStatusEntry[] = [];
  for (const [name, status] of statusMap) {
    const tools = toolSnapshots.get(name) ?? [];
    entries.push({ name, status, toolCount: tools.length });
  }
  return entries;
}

export function getMCPServerTools(serverName: string): ToolSnapshot[] {
  return toolSnapshots.get(serverName) ?? [];
}

export async function reconnectMCPServer(name: string, config: McpServerConfig): Promise<void> {
  statusMap.set(name, "reconnecting");
  try {
    const client = new MCPClient();
    await client.connect(config.command, config.args || [], config.env);

    const tools = await client.listTools();
    toolSnapshots.set(name, tools.map(t => ({ name: t.name, inputSchema: t.inputSchema as Record<string, unknown> | undefined })));

    for (const tool of tools) {
      const namespacedName = `${name}/${tool.name}`;
      registry.register({
        def: {
          name: namespacedName,
          description: tool.description || `MCP tool from ${name}: ${tool.name}`,
          parameters: tool.inputSchema
            ? { type: "object", properties: tool.inputSchema.properties ?? {}, required: tool.inputSchema.required ?? [] }
            : { type: "object", properties: {}, required: [] },
        },
        handler: async (args) => {
          const result = await client.callTool(tool.name, args);
          const content = result.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
          return result.isError
            ? { content, error: content }
            : { content };
        },
        groups: ["mcp", name] as ToolGroup[],
      });
    }

    statusMap.set(name, "connected");
    process.stderr.write(`  [mcp] ${name}: ${tools.length} tool(s) registered\n`);
  } catch (err) {
    statusMap.set(name, "failed");
    process.stderr.write(`  [mcp] ${name}: connection failed — ${(err as Error).message}\n`);
  }
}

export async function connectMCPServers(servers: Record<string, McpServerConfig>): Promise<void> {
  for (const [name, config] of Object.entries(servers)) {
    serverConfigsMap.set(name, config);
    statusMap.set(name, "starting");
    await reconnectMCPServer(name, config);
  }
}
