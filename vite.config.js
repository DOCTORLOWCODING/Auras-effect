import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    sourcemap: false,
    reportCompressedSize: true,
    rollupOptions: {
      input: {
        index: resolve(process.cwd(), "index.html"),
        background: resolve(process.cwd(), "background.html"),
      },
    },
  },
});
