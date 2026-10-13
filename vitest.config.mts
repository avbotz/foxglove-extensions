import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["common/**/*.test.ts", "*/src/**/*.test.ts"],
  },
});
