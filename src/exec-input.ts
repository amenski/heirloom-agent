export interface ExecInputStream extends AsyncIterable<unknown> {
  isTTY?: boolean;
}

export async function buildExecPrompt(prompt: string, input: ExecInputStream = process.stdin): Promise<string> {
  if (input.isTTY === true) return prompt;

  let bytes: Buffer;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of input) {
      if (Buffer.isBuffer(chunk)) chunks.push(chunk);
      else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
      else chunks.push(Buffer.from(String(chunk), "utf8"));
    }
    bytes = Buffer.concat(chunks);
  } catch (error) {
    throw new Error(`Failed to read stdin: ${(error as Error).message}`);
  }

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`Failed to decode stdin as UTF-8: ${(error as Error).message}`);
  }

  if (content.trim() === "") return prompt;

  const trailingNewline = content.endsWith("\n") ? "" : "\n";
  return `${prompt}\n\n<stdin>\n${content}${trailingNewline}</stdin>`;
}
