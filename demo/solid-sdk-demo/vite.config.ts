import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [solid()],
  publicDir: resolve(rootDir, "public"),
  resolve: {
    alias: {
      webcli: resolve(rootDir, "../../sdk/src/index.ts"),
    },
  },
});
