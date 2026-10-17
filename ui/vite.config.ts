import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 개발 전용: 모의 링크(127.0.0.1, domain 88)로 API·WS 를 넘긴다. 이 개발 서버는 127.0.0.1 에만 연다.
// 서버의 Origin 검사는 그대로 두고, 개발 프록시가 대상 주소를 Origin 으로 붙인다(운영 배포 경로가 아님 — 운영은 같은 출처에서 dist 서빙).
const LINK = process.env.FH_LINK || 'http://127.0.0.1:8791';
const sameOrigin = { target: LINK, changeOrigin: true, configure: (p: any) => {
  p.on('proxyReq', (r: any) => r.setHeader('origin', LINK));
  p.on('proxyReqWs', (r: any) => r.setHeader('origin', LINK));
} };

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: { alias: { '@contracts': fileURLToPath(new URL('../contracts/v1/ts/index.ts', import.meta.url)) } },   // 백엔드 계약 생성물(읽기만)
  server: { host: '127.0.0.1', port: 5181, strictPort: true, fs: { allow: ['..'] },
    proxy: { '/api': sameOrigin, '/media': sameOrigin, '/ws': { ...sameOrigin, ws: true } } },
  preview: { host: '127.0.0.1', port: 5182, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },   // parity.html 은 시험 전용 — 빌드 입력에 넣지 않는다(index.html 만)
});
