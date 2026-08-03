import { describe, it, expect } from "vitest";
import {
  detectWrapper,
  extractQuotedArg,
  splitCompound,
  stripSudo,
  isUnresolved,
  buildBashSubject,
  FORK_BOMB,
} from "./bash-normalize.js";

describe("extractQuotedArg / detectWrapper", () => {
  it("unwraps bash -c 'cmd'", () => {
    expect(extractQuotedArg("bash -c 'git status'")).toBe("git status");
  });

  it("unwraps sh -c \"cmd\"", () => {
    expect(extractQuotedArg('sh -c "git status"')).toBe("git status");
  });

  it("unwraps eval cmd form", () => {
    const r = detectWrapper("eval 'rm -rf /tmp/x'");
    expect(r).toEqual({ text: "rm -rf /tmp/x", failedUnwrap: false });
  });

  it("fails to unwrap when the inner command has command substitution", () => {
    expect(extractQuotedArg("bash -c 'echo $(whoami)'")).toBeNull();
  });

  it("fails to unwrap unquoted bash -c content", () => {
    expect(extractQuotedArg("bash -c echo hi")).toBeNull();
  });

  it("marks failedUnwrap true when wrapper detected but unwrap fails", () => {
    const r = detectWrapper("bash -c 'echo `whoami`'");
    expect(r.failedUnwrap).toBe(true);
  });

  it("passes through commands with no wrapper unchanged", () => {
    const r = detectWrapper("git status");
    expect(r).toEqual({ text: "git status", failedUnwrap: false });
  });
});

describe("splitCompound", () => {
  it("splits on top-level &&", () => {
    expect(splitCompound("git status && rm -rf /")).toEqual(["git status", "rm -rf /"]);
  });

  it("splits on top-level ;", () => {
    expect(splitCompound("echo a; echo b")).toEqual(["echo a", "echo b"]);
  });

  it("splits on top-level |", () => {
    expect(splitCompound("cat file | grep x")).toEqual(["cat file", "grep x"]);
  });

  it("splits on ||", () => {
    expect(splitCompound("test -f x || rm -rf x")).toEqual(["test -f x", "rm -rf x"]);
  });

  it("does not split operators inside single quotes", () => {
    expect(splitCompound("echo 'a && b'")).toEqual(["echo 'a && b'"]);
  });

  it("does not split operators inside double quotes", () => {
    expect(splitCompound('echo "a; b"')).toEqual(['echo "a; b"']);
  });

  it("splits on a single trailing &", () => {
    expect(splitCompound("sleep 10 &")).toEqual(["sleep 10"]);
  });

  it("does not shred the fork-bomb literal on its bare pipe", () => {
    expect(splitCompound(FORK_BOMB)).toEqual([FORK_BOMB]);
  });

  it("splits on newlines", () => {
    expect(splitCompound("echo a\necho b")).toEqual(["echo a", "echo b"]);
  });
});

describe("stripSudo", () => {
  it("strips a leading sudo", () => {
    expect(stripSudo("sudo npm test")).toBe("npm test");
  });

  it("leaves non-sudo commands unchanged", () => {
    expect(stripSudo("npm test")).toBe("npm test");
  });
});

describe("isUnresolved: fail-closed detection", () => {
  it("flags env-wrapped commands", () => {
    expect(isUnresolved("env rm -rf ~/projects")).toBe(true);
  });

  it("flags bare NAME=value assignment prefixes", () => {
    expect(isUnresolved("FOO=1 rm -rf ~")).toBe(true);
  });

  it("flags nice/nohup/timeout/command wrappers", () => {
    expect(isUnresolved("nice rm -rf ~")).toBe(true);
    expect(isUnresolved("nohup rm -rf ~")).toBe(true);
    expect(isUnresolved("timeout 5 rm -rf ~")).toBe(true);
    expect(isUnresolved("command rm -rf ~")).toBe(true);
  });

  it("flags find -exec", () => {
    expect(isUnresolved("find . -exec rm -rf {} \\;")).toBe(true);
  });

  it("flags find -execdir", () => {
    expect(isUnresolved("find . -execdir rm -rf {} \\;")).toBe(true);
  });

  it("flags find -ok and -okdir", () => {
    expect(isUnresolved("find . -ok rm {} \\;")).toBe(true);
    expect(isUnresolved("find . -okdir rm {} \\;")).toBe(true);
  });

  it("does not flag a bare find without -exec", () => {
    expect(isUnresolved("find . -name '*.ts'")).toBe(false);
  });

  it("flags sudo as the first token (even without flags)", () => {
    expect(isUnresolved("sudo rm -rf /")).toBe(true);
  });

  it("flags sudo with flags (-u, -E, --)", () => {
    expect(isUnresolved("sudo -u root rm -rf /")).toBe(true);
    expect(isUnresolved("sudo -E rm -rf /")).toBe(true);
    expect(isUnresolved("sudo -- rm -rf /")).toBe(true);
  });

  it("flags xargs as the first token of a segment", () => {
    expect(isUnresolved("xargs rm")).toBe(true);
  });

  it("flags inline command substitution", () => {
    expect(isUnresolved("echo $(rm -rf ~)")).toBe(true);
  });

  it("flags backtick command substitution", () => {
    expect(isUnresolved("echo `rm -rf ~`")).toBe(true);
  });

  it("flags process substitution (both <( and >( directions)", () => {
    expect(isUnresolved("diff <(cat a) <(cat b)")).toBe(true);
    expect(isUnresolved("tee >(cat)")).toBe(true);
  });

  it("flags a bare sh/bash first token not already a full wrapper", () => {
    expect(isUnresolved("sh script.sh")).toBe(true);
  });

  it("does not flag an ordinary command", () => {
    expect(isUnresolved("git status")).toBe(false);
    expect(isUnresolved("npm test")).toBe(false);
  });

  it("flags a backslash-escaped first token (fail-closed instead of silently falling through)", () => {
    expect(isUnresolved("\\rm -rf /")).toBe(true);
  });

  it("flags a quoted first token", () => {
    expect(isUnresolved("'rm' -rf /")).toBe(true);
    expect(isUnresolved('"rm" -rf /')).toBe(true);
  });

  it("does not flag ordinary paths starting with . / ~ or -", () => {
    // These are legitimate leading characters for real commands/args and
    // must not be swept up by the not-a-bare-word check.
    expect(isUnresolved("./script.sh")).toBe(false);
    expect(isUnresolved("~/bin/tool")).toBe(false);
    expect(isUnresolved("-x")).toBe(false);
  });
});

describe("buildBashSubject", () => {
  it("returns per-segment subjects for a compound command", () => {
    const r = buildBashSubject("git status && npm test");
    expect(r.segments).toEqual(["git status", "npm test"]);
    expect(r.wasUnresolved).toBe(false);
  });

  it("flags sudo-prefixed segments as unresolved (sudo is privilege escalation)", () => {
    const r = buildBashSubject("sudo npm test");
    expect(r.segments).toEqual(["sudo npm test"]);
    expect(r.wasUnresolved).toBe(true);
  });

  it("still strips sudo from a segment that is otherwise resolved", () => {
    // sudo is caught by isUnresolved first, so stripSudo only matters for
    // non-sudo segments — but keep the test to verify stripSudo itself.
    expect(stripSudo("sudo npm test")).toBe("npm test");
  });

  it("flags wasUnresolved when any segment is unresolved", () => {
    const r = buildBashSubject("git status && env rm -rf ~/projects");
    expect(r.wasUnresolved).toBe(true);
  });

  it("flags wasUnresolved with no segments when the wrapper fails to unwrap", () => {
    const r = buildBashSubject("bash -c 'echo $(whoami)'");
    expect(r.wasUnresolved).toBe(true);
    expect(r.segments).toEqual([]);
  });

  it("unwraps a clean bash -c wrapper into a single resolvable segment", () => {
    const r = buildBashSubject("bash -c 'git status'");
    expect(r.segments).toEqual(["git status"]);
    expect(r.wasUnresolved).toBe(false);
  });

  it("flags a piped xargs command end-to-end", () => {
    const r = buildBashSubject("echo file | xargs rm");
    expect(r.segments).toEqual(["echo file", "xargs rm"]);
    expect(r.wasUnresolved).toBe(true);
  });
});

