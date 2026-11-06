import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./web/src", import.meta.url)) } },
  test: {
    maxWorkers: 2,
    fileParallelism: false,
  },
});
