import { defineConfig } from 'vite';

// GitHub Pages serves the site from /<repo>/; local dev serves from /.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? (process.env.BASE_PATH ?? '/critter-jam/') : '/',
  // three.js is most of the bundle; that's expected.
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
}));
