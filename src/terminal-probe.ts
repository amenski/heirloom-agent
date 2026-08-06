// DEC private mode 2026 (synchronized output). Ink wraps each frame in
// \x1b[?2026h ... \x1b[?2026l markers. Terminals that honor the mode paint a
// frame atomically; terminals that ignore it paint every partial write,
// which shows up as visible tearing while streaming. IntelliJ's JediTerm is
// the suspected non-supporter that motivated this probe.
//
// The check is DECRQM ("request mode"): write `\x1b[?2026$p` and the
// terminal should reply `\x1b[?2026;N$y` where N=0 means "not recognized"
// and N in {1,2,3,4} means recognized (set/reset, permanently set/reset).
// Many terminals reply nothing at all, so the probe must time out gracefully
// rather than hang.

const DECRQM_RESPONSE = /\x1b\[\?2026;(\d+)\$y/;

export function parseDecrqmResponse(buf: string): "supported" | "unsupported" | null {
  const match = DECRQM_RESPONSE.exec(buf);
  if (!match) return null;
  const code = match[1];
  if (code === "0") return "unsupported";
  if (code === "1" || code === "2" || code === "3" || code === "4") return "supported";
  return null;
}

export function probeSyncOutput(
  timeoutMs = 250,
): Promise<"supported" | "unsupported" | "no-response" | "skipped"> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return Promise.resolve("skipped");
  }

  return new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
    let settled = false;
    let acc = "";
    let timer: NodeJS.Timeout;

    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
    };

    const finish = (result: "supported" | "unsupported" | "no-response") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(result);
    };

    const onData = (chunk: Buffer) => {
      acc += chunk.toString("utf8");
      const parsed = parseDecrqmResponse(acc);
      if (parsed !== null) finish(parsed);
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);

    timer = setTimeout(() => finish("no-response"), timeoutMs);

    process.stdout.write("\x1b[?2026$p");
  });
}
