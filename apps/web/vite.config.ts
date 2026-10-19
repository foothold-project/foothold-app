/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 새 웹 앱 개발 서버는 127.0.0.1:5180 만(운영 앱·기존 ui 개발 서버 5181·5182 와 겹치지 않게).
// /api → 로컬 관제 서버(apps/server README 의 uvicorn 127.0.0.1:8810). 운영 포트(8453·8792)는 쓰지 않는다.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: { host: '127.0.0.1', port: 5180, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8810' } },
  preview: { host: '127.0.0.1', port: 5183, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
  test: { environment: 'jsdom' },
});
