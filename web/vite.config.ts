import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [svelte()],
  server: { proxy: { '/api': 'http://127.0.0.1:8787' }, fs: { allow: ['.', '../server/src/shared'] } }, // 개발 시 프록시 · 공유 모듈(server/src/shared) 읽기 허용
  build: { outDir: 'dist', sourcemap: false },
  resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
  test: { include: ['test/**/*.test.ts'], environment: 'happy-dom' },
});
