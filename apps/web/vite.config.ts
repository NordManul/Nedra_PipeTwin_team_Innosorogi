import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  // относительные пути: сборку можно открыть с любого адреса (GitHub Pages, файл)
  base: './',
  server: { port: 5173, fs: { allow: [repoRoot] } },
  preview: { port: 4173 },
  worker: { format: 'es' },
  build: { target: 'es2022', outDir: 'dist', chunkSizeWarningLimit: 2000 },
});
