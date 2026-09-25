import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// The browser only ever talks to the Avlija server, which proxies go2rtc's
// WHEP signalling. So the dev server just proxies /api to that server.
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/web'),
  build: {
    outDir: resolve(import.meta.dirname, 'dist/web'),
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    port: 5174,
    proxy: {
      '/api': { target: 'http://127.0.0.1:5173', changeOrigin: true },
    },
  },
});
