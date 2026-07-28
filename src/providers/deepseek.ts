import { initPresets, createProvider } from "./presets.js";
import type { Provider } from "./types.js";

initPresets();

export function createDeepSeekProvider(): Provider {
  return createProvider("deepseek");
}
