import React from "react";
import { Box, Text, Static } from "ink";
import MarkdownText from "./MarkdownText.js";

interface OutputAreaProps {
  lines: string[];
  activeLine: string;
  busy: boolean;
}

/** Scrollable output of past messages + the live streaming line. */
export default function OutputArea({ lines, activeLine, busy }: OutputAreaProps) {
  return (
    <>
      <Static items={lines}>
        {(line, i) => (
          <Box key={i}>
            <MarkdownText>{line}</MarkdownText>
          </Box>
        )}
      </Static>

      {activeLine !== "" && !busy && <MarkdownText>{activeLine}</MarkdownText>}
    </>
  );
}
