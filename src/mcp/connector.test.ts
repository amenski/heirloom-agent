import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { McpServerConfig } from "../config/loader.js";
import { registry } from "../tools/index.js";

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

// Capture the connector's stderr writes (pin-change warnings) during tests.
const stderrWrites: string[] = [];
vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
  stderrWrites.push(String(chunk));
  return true;
});

import { connectMCPServers, getMCPServerStatuses, reconnectMCPServer } from "./connector.js";

function statusFor(name: string) {
  return getMCPServerStatuses().find((s) => s.name === name);
}

// Isolate the pins store (~/.heirloom/mcp-pins.json) per test run.
let testHome = "";
beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "heirloom-mcp-pins-"));
  process.env.HEIRLOOM_HOME = testHome;
  stderrWrites.length = 0;
});
afterEach(() => {
  delete process.env.HEIRLOOM_HOME;
  rmSync(testHome, { recursive: true, force: true });
});

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

  it("blocks a disallowed command when strictMcpConfig is absent (defaults on — defense in depth)", async () => {
    await connectMCPServers(disallowed);

    expect(connectMock).not.toHaveBeenCalled();
    expect(statusFor("malware")?.status).toBe("failed");
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

describe("tool-definition pinning (T10)", () => {
  const server: McpServerConfig = { command: "npx", args: ["server"] };

  const alphaDef = (description = "do alpha", props: Record<string, unknown> = { x: { type: "string" } }) => ({
    name: "alpha",
    description,
    inputSchema: { type: "object", properties: props },
  });
  const betaDef = { name: "beta", description: "do beta", inputSchema: { type: "object", properties: {} } };

  /** The currently registered def for mcp__<server>__alpha, if any. */
  function registeredAlphaDef(serverName: string) {
    return registry.getByMode(["mcp"]).find((d) => d.name === `mcp__${serverName}__alpha`);
  }

  it("first-ever connect pins without prompting and registers the tools", async () => {
    listToolsMock.mockResolvedValueOnce([alphaDef(), betaDef]);
    await connectMCPServers({ pin1: server });

    expect(statusFor("pin1")?.status).toBe("connected");
    expect(statusFor("pin1")?.pinChanged).toBeUndefined();
    expect(registeredAlphaDef("pin1")?.description).toBe("do alpha");
    expect(stderrWrites.join("")).not.toContain("pin1");
    expect(existsSync(join(testHome, "mcp-pins.json"))).toBe(true);
  });

  it("reconnect with unchanged defs is silent — no flag, tools re-registered", async () => {
    listToolsMock.mockResolvedValue([alphaDef(), betaDef]);
    await connectMCPServers({ pin2: server });
    expect(statusFor("pin2")?.pinChanged).toBeUndefined();

    await reconnectMCPServer("pin2", server);

    expect(statusFor("pin2")?.pinChanged).toBeUndefined();
    expect(stderrWrites.join("")).not.toContain("pin2");
    expect(registeredAlphaDef("pin2")?.description).toBe("do alpha");
  });

  it("a description/schema change flags the server and is NOT re-registered", async () => {
    listToolsMock.mockResolvedValue([alphaDef(), betaDef]);
    await connectMCPServers({ pin3: server });
    expect(registeredAlphaDef("pin3")?.description).toBe("do alpha");

    // Rug pull: the server now advertises a changed description + schema.
    listToolsMock.mockResolvedValue([
      alphaDef("do alpha — NOW MALICIOUS", { x: { type: "string" }, evil: { type: "boolean" } }),
      betaDef,
    ]);
    await reconnectMCPServer("pin3", server);

    expect(statusFor("pin3")?.status).toBe("connected");
    expect(statusFor("pin3")?.pinChanged).toBe(true);
    expect(stderrWrites.join("")).toContain("pin3");
    expect(stderrWrites.join("")).toContain("re-approve");
    // The old trusted def stays registered; the changed defs never landed.
    expect(registeredAlphaDef("pin3")?.description).toBe("do alpha");
  });

  it("a tool being added or removed is a pin change too", async () => {
    listToolsMock.mockResolvedValue([alphaDef(), betaDef]);
    await connectMCPServers({ pin6: server });

    listToolsMock.mockResolvedValue([alphaDef(), betaDef, { name: "gamma", description: "new tool", inputSchema: { type: "object", properties: {} } }]);
    await reconnectMCPServer("pin6", server);
    expect(statusFor("pin6")?.pinChanged).toBe(true);
  });

  it("approving via reconnect (approvePinChange) re-pins and registers the new defs", async () => {
    listToolsMock.mockResolvedValue([alphaDef(), betaDef]);
    await connectMCPServers({ pin4: server });

    listToolsMock.mockResolvedValue([alphaDef("do alpha — NOW MALICIOUS"), betaDef]);
    await reconnectMCPServer("pin4", server);
    expect(statusFor("pin4")?.pinChanged).toBe(true);
    expect(registeredAlphaDef("pin4")?.description).toBe("do alpha");

    await reconnectMCPServer("pin4", server, { approvePinChange: true });
    expect(statusFor("pin4")?.pinChanged).toBeUndefined();
    expect(registeredAlphaDef("pin4")?.description).toBe("do alpha — NOW MALICIOUS");

    // The approved pin persists: a later unchanged reconnect stays silent.
    stderrWrites.length = 0;
    await reconnectMCPServer("pin4", server);
    expect(statusFor("pin4")?.pinChanged).toBeUndefined();
    expect(stderrWrites.join("")).not.toContain("pin4");
  });

  it("the pins store is 0600 and holds only hashes — no descriptions or schemas", async () => {
    listToolsMock.mockResolvedValueOnce([
      { name: "alpha", description: "secret-description", inputSchema: { type: "object", properties: { secretKey: { type: "string" } } } },
    ]);
    await connectMCPServers({ pin5: server });

    const raw = readFileSync(join(testHome, "mcp-pins.json"), "utf-8");
    expect(raw).not.toContain("secret-description");
    expect(raw).not.toContain("secretKey");
    expect(raw).toMatch(/[0-9a-f]{64}/);
    expect(statSync(join(testHome, "mcp-pins.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(testHome)).toEqual(["mcp-pins.json"]); // atomic: no tmp leftovers
  });
});
