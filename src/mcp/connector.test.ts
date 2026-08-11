import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServerConfig } from "../config/loader.js";

// Mock the MCP client so no real process is ever spawned.
const connectMock = vi.fn(async () => {});
const listToolsMock = vi.fn(async () => [] as { name: string; description?: string; inputSchema?: unknown }[]);

vi.mock("./client.js", () => ({
  MCPClient: class {
    connect = connectMock;
    listTools = listToolsMock;
    callTool = vi.fn(async () => ({ content: [] }));
    disconnect = vi.fn();
  },
}));

// Silence the connector's stderr writes during tests.
vi.spyOn(process.stderr, "write").mockImplementation(() => true);

import { connectMCPServers, getMCPServerStatuses } from "./connector.js";

function statusFor(name: string) {
  return getMCPServerStatuses().find((s) => s.name === name);
}

describe("connectMCPServers strictMcpConfig allowlist", () => {
  beforeEach(() => {
    connectMock.mockClear();
    listToolsMock.mockClear();
  });

  const disallowed: Record<string, McpServerConfig> = {
    malware: { command: "/usr/local/bin/malware", args: [] },
  };

  it("blocks a disallowed command when strictMcpConfig is true (no spawn)", async () => {
    await connectMCPServers(disallowed, { strictMcpConfig: true });

    expect(connectMock).not.toHaveBeenCalled();

    const entry = statusFor("malware");
    expect(entry?.status).toBe("failed");
    expect(entry?.error).toContain("strictMcpConfig");
    expect(entry?.error).toContain("/usr/local/bin/malware");
    expect(entry?.error).toContain("malware"); // basename named
    expect(entry?.error).toContain("strictMcpConfig\": false");
  });

  it("allows a disallowed command when strictMcpConfig is false", async () => {
    await connectMCPServers(disallowed, { strictMcpConfig: false });

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledWith("/usr/local/bin/malware", [], undefined);

    const entry = statusFor("malware");
    expect(entry?.status).toBe("connected");
    expect(entry?.error).toBeUndefined();
  });

  it("allows a disallowed command when strictMcpConfig is absent (defaults off)", async () => {
    await connectMCPServers(disallowed);

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(statusFor("malware")?.status).toBe("connected");
  });

  it("allows an allowlisted command (by basename) when strictMcpConfig is true", async () => {
    const allowed: Record<string, McpServerConfig> = {
      py: { command: "/usr/bin/python3", args: ["server.py"] },
    };

    await connectMCPServers(allowed, { strictMcpConfig: true });

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledWith("/usr/bin/python3", ["server.py"], undefined);
    expect(statusFor("py")?.status).toBe("connected");
  });

  it("blocks case-mismatched allowlist entries (Node is not node)", async () => {
    const cased: Record<string, McpServerConfig> = {
      cased: { command: "Node", args: [] },
    };

    await connectMCPServers(cased, { strictMcpConfig: true });

    expect(connectMock).not.toHaveBeenCalled();
    expect(statusFor("cased")?.status).toBe("failed");
  });
});
