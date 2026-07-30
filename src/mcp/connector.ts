import { MCPClient } from "./client.js";
import { registry } from "../tools/index.js";
import type { ToolGroup } from "../tools/types.js";
import type { McpServerConfig } from "../config/loader.js";

interface ToolSnapshot {
  name: string;
  inputSchema: unknown;
}

const toolSnapshots = new Map<string, ToolSnapshot[]>();

export async function connectMCPServers(servers: Record<string, McpServerConfig>): Promise<void> {
  for (const [name, config] of Object.entries(servers)) {
    try {
      const client = new MCPClient();
      await client.connect(config.command, config.args || [], config.env);

      const tools = await client.listTools();
      const prev = toolSnapshots.get(name);

      if (prev) {
        const prevNames = new Set(prev.map(t => t.name));
        const currNames = new Set(tools.map(t => t.name));

        const added = tools.filter(t => !prevNames.has(t.name));
        const removed = prev.filter(t => !currNames.has(t.name));

        if (added.length || removed.length) {
          process.stderr.write(`  [mcp] ${name}: tool definitions changed since last connect\n`);
          if (added.length) process.stderr.write(`    +${added.map(t => t.name).join(", ")}\n`);
          if (removed.length) process.stderr.write(`    -${removed.map(t => t.name).join(", ")}\n`);
        }
      }

      toolSnapshots.set(name, tools.map(t => ({ name: t.name, inputSchema: t.inputSchema })));

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

      process.stderr.write(`  [mcp] ${name}: ${tools.length} tool(s) registered\n`);
    } catch (err) {
      process.stderr.write(`  [mcp] ${name}: connection failed — ${(err as Error).message}\n`);
    }
  }
}
