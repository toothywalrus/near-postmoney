import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolve } from "node:path";

// The redesigned page (web/next). It reads the same contracts with the same chain reader and reference as the first page
// (web/src, ../ref), and builds into dist/next, so one deploy of dist serves both. Built after the first page, whose build
// empties dist.
export default defineConfig({
  root: resolve(import.meta.dirname, "next"),
  plugins: [react()],
  base: "./",
  publicDir: resolve(import.meta.dirname, "public"),
  server: { port: 5194, fs: { allow: [resolve(import.meta.dirname, "..")] } },
  build: { target: "es2022", outDir: resolve(import.meta.dirname, "dist/next"), emptyOutDir: true },
});
