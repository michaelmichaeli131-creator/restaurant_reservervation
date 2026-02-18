import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../public/dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        // Existing editor app
        "floor-app": path.resolve(__dirname, "src/main.tsx"),
        // New view-only app for waiter/host screens
        "floor-view-app": path.resolve(__dirname, "src/view/floorViewMain.tsx"),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === "floor-app") return "floor-app.js";
          if (chunkInfo.name === "floor-view-app") return "floor-view-app.js";
          return "[name].js";
        },
        chunkFileNames: "floor-[name].js",
        assetFileNames: "floor-[name].[ext]",
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
});
