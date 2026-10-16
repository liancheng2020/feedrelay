import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  root: 'web',
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    port: Number(process.env.WEB_PORT || 5183),
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${process.env.PORT || 8787}` },
  },
});
