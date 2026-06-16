import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "CommerceAgentWidget",
      formats: ["iife", "es"],
      fileName: (format) =>
        format === "iife" ? "commerce-agent-widget.js" : "commerce-agent-widget.es.js",
    },
    rollupOptions: {
      output: {
        extend: true,
      },
    },
    outDir: "dist",
    emptyOutDir: true,
  },
});
