/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 새 웹 앱 개발 서버는 127.0.0.1:5180 만(운영 앱·기존 ui 개발 서버 5181·5182 와 겹치지 않게). 서버 프록시 없음 — 가짜 데이터만.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: { host: '127.0.0.1', port: 5180, strictPort: true },
  preview: { host: '127.0.0.1', port: 5183, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
  test: { environment: 'jsdom' },
});
