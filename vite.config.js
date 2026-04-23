import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.VITE_BASE ?? '/',

  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },

  build: {
    outDir: 'dist',
    assetsInlineLimit: 4096,
  },

  test: {
    environment: 'node',
  },
});
