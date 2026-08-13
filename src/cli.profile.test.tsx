import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { profileLevelSegment } from "./cli.js";
import StatusBar from "./ui/StatusBar.js";
import { stripAnsi } from "./ui/test-helpers.js";

// profileLevelSegment is exported from cli.tsx for the same reason
// handleSlashCore/completer are: unit-testing the status-line decision
// (permission-profile.md §9) without running the real CLI startup.

describe("profileLevelSegment (status-line level marker)", () => {
  it("renders a dim level segment when a profile level is configured", () => {
    expect(profileLevelSegment("workspace-write")).toEqual([
      { id: "profile", text: "profile: workspace-write", dimColor: true },
    ]);
    expect(profileLevelSegment("strict-sandbox")).toEqual([
      { id: "profile", text: "profile: strict-sandbox", dimColor: true },
    ]);
    expect(profileLevelSegment("unrestricted")).toEqual([
      { id: "profile", text: "profile: unrestricted", dimColor: true },
    ]);
  });

  it("renders no segment when no profile is configured (status bar unchanged)", () => {
    expect(profileLevelSegment(undefined)).toEqual([]);
  });

  it("renders beside the posture segment, joined by the ' · ' separator", () => {
    const { lastFrame } = render(
      <StatusBar
        segments={[
          { id: "posture", text: "normal", dimColor: true },
          ...profileLevelSegment("workspace-write"),
        ]}
      />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("normal · profile: workspace-write");
  });

  it("renders no level marker in the frame when unconfigured", () => {
    const { lastFrame } = render(
      <StatusBar segments={[{ id: "posture", text: "normal", dimColor: true }]} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("normal");
    expect(frame).not.toContain("profile:");
  });
});
