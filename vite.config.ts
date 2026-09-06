import { defineConfig } from "vite";

export default defineConfig({
  build: {
    ssr: "server.ts",
    rollupOptions: { output: { entryFileNames: "server.mjs" } }
  }
});
