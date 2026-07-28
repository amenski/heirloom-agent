import type { ToolDef, ToolOutput } from "../types.js";

export interface McpServerConfig {
  name: string;
  url: string;
}

const MCP_TIMEOUT_MS = 10_000;
const PROTOCOL_VERSION = "2024-11-05";

interface McpInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolsListResult {
  tools: McpTool[];
}

interface McpToolCallContent {
  type: "text";
  text: string;
}

interface McpToolCallResult {
  content: McpToolCallContent[];
  isError?: boolean;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

let requestId = 1;

async function mcpRequest<T>(
  url: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const body: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: requestId++,
    method,
    params,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `MCP server returned HTTP ${response.status}: ${response.statusText}`,
    );
  }

  const text = await response.text();
  let data: JsonRpcResponse;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `MCP server returned non-JSON response: ${text.slice(0, 200)}`,
    );
  }

  if (data.error) {
    throw new Error(`MCP error ${data.error.code}: ${data.error.message}`);
  }

  return data.result as T;
}

export async function listTools(
  config: McpServerConfig,
): Promise<ToolDef[]> {
  try {
    await mcpRequest<McpInitializeResult>(config.url, "initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "heirloom", version: "1.0.0" },
    });

    const result = await mcpRequest<McpToolsListResult>(
      config.url,
      "tools/list",
    );

    return result.tools.map(
      (t): ToolDef => ({
        name: `${config.name}/${t.name}`,
        description: t.description ?? "",
        parameters: {
          type: "object",
          properties: t.inputSchema.properties ?? {},
          required: t.inputSchema.required ?? [],
        },
      }),
    );
  } catch {
    return [];
  }
}

export async function callTool(
  config: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolOutput> {
  try {
    const shortName = toolName.startsWith(`${config.name}/`)
      ? toolName.slice(config.name.length + 1)
      : toolName;

    const result = await mcpRequest<McpToolCallResult>(
      config.url,
      "tools/call",
      { name: shortName, arguments: args },
    );

    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    return result.isError
      ? { content: text, error: text }
      : { content: text };
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "TimeoutError")
    ) {
      return {
        content: "",
        error: `Tool call timed out after ${MCP_TIMEOUT_MS}ms`,
      };
    }
    return { content: "", error: (err as Error).message };
  }
}
