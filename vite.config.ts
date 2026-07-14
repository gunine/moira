import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// GitHub Pages serves from the https://<account>.github.io/moira/ subpath,
// so apply the base only to production builds. The dev server (npm run dev)
// keeps serving from the http://localhost:5173/ root as before.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/moira/" : "/",
  plugins: [react()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
}));
