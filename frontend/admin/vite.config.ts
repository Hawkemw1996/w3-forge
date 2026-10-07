import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Admin Console SPA build.
// - base: '/admin/' so all built asset URLs are served under /admin/.
// - outDir: './dist' so the Forge backend can serve the built SPA from
//   frontend/admin/dist (the path it probes in src/index.ts).
// - alias '@' -> 'src' for cleaner imports.
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@shared': path.resolve(__dirname, '../shared')
    }
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020'
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8765',
      '/health': 'http://localhost:8765',
      '/version': 'http://localhost:8765'
    }
  }
});
