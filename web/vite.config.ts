import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In development the API runs separately; in production Express serves this build itself.
    proxy: { '/api': { target: 'http://localhost:8080', changeOrigin: false } },
  },
  build: { outDir: 'dist', sourcemap: false, assetsInlineLimit: 0 },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test-setup.ts'], css: false },
});
