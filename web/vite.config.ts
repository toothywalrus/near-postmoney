import { defineConfig } from "vite";

// A static build that works from any path (serve web/dist/ with any static server).
export default defineConfig({
  base: "./",
  server: { fs: { allow: [".."] } },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
});
