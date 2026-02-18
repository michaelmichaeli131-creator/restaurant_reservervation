import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Multi-entry build:
// - floor-app: the existing editor app
// - floor-view-app: the new view-only app for waiter/host screens
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../public/dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'floor-app': path.resolve(__dirname, 'src/main.tsx'),
        'floor-view-app': path.resolve(__dirname, 'src/view/floorViewMain.tsx'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'floor-app') return 'floor-app.js';
          if (chunkInfo.name === 'floor-view-app') return 'floor-view-app.js';
          return '[name].js';
        },
        chunkFileNames: 'floor-[name].js',
        assetFileNames: 'floor-[name].[ext]'
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true
      }
    }
  }
});
