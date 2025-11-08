import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../public/dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'floor-app.js',
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
