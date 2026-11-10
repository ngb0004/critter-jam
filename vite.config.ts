import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// GitHub Pages serves the site from /<repo>/; local dev serves from /.
// Two pages: the landing page at the root, and the game at /play/.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? (process.env.BASE_PATH ?? '/critter-jam/') : '/',
  // three.js is most of the bundle; that's expected.
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        landing: resolve(__dirname, 'index.html'),
        play: resolve(__dirname, 'play/index.html'),
        privacy: resolve(__dirname, 'privacy.html'),
        delve: resolve(__dirname, 'delve/index.html'),
      },
    },
  },
}));
