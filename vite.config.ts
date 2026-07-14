import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// GitHub Pages는 https://<계정명>.github.io/moira/ 하위 경로로 서빙되므로
// 프로덕션 빌드에만 base를 적용한다. dev 서버(npm run dev)는 기존처럼
// http://localhost:5173/ 루트에서 동작한다.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/moira/" : "/",
  plugins: [react()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
}));
