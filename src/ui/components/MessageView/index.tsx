import React from "react";
import { Box, Text } from "ink";

export interface MessageItem {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  toolName?: string;
}

interface Props {
  message: MessageItem;
  width: number;
}

const MessageView = React.memo(function MessageView({ message, width }: Props) {
  const content = message.content || "";
  const lines = content.split("\n");
  const maxLines = 200;
  const truncated = lines.length > maxLines;
  const visible = truncated ? lines.slice(0, maxLines) : lines;

  const roleColor = message.role === "user" ? "#229ac3" : message.role === "tool" ? undefined : undefined;
  const dim = message.role === "tool" || message.role === "system";

  return (
    <Box flexDirection="column" width={width} marginBottom={1}>
      {message.role === "user" && (
        <Box>
          <Text color="#229ac3" bold>{"\u276F"} </Text>
        </Box>
      )}
      {message.toolName && (
        <Box>
          <Text dimColor>[{message.toolName}]</Text>
        </Box>
      )}
      {visible.map((line, i) => (
        <Text key={i} color={roleColor} dimColor={dim} wrap="wrap">
          {line || " "}
        </Text>
      ))}
      {truncated && (
        <Text dimColor>... ({content.length - maxLines} more lines)</Text>
      )}
    </Box>
  );
});

export default MessageView;
