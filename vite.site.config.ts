import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  root: 'site',
  base: './',
  plugins: [vue()],
  build: { outDir: '../dist/site', emptyOutDir: true },
});
