/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { phonePorts } from './src/phoneTransport';
import { phoneProxy, tunnelGuard, tunnelOrigin } from './tunnel';

// 새 웹 앱 개발 서버는 127.0.0.1:5180 만(운영 앱·기존 ui 개발 서버 5181·5182 와 겹치지 않게).
// /api(실시간 WS /api/v1/ws 포함) → 로컬 관제 서버(apps/server README 의 uvicorn 127.0.0.1:8810). 운영 포트(8453·8792)는 쓰지 않는다.
// 다른 로컬 서버면 FH_API=http://127.0.0.1:<포트>. Host 를 바꾸지 않아(changeOrigin 없음) 서버의 Origin 검사가 이 화면 출처와 맞는다
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'FH_'), origin = tunnelOrigin(env), ports = phonePorts(env.FH_PHONE_PORT_RANGE);
  return {
    plugins: [react(), tunnelGuard(origin, ports)],
    base: './',
    cacheDir: '../../tmp/phone-tunnel/vite',
    define: { 'import.meta.env.FH_PHONE_PORT_RANGE': JSON.stringify(env.FH_PHONE_PORT_RANGE || '9430:9449') },
    server: { host: '127.0.0.1', port: 5180, strictPort: true,
      allowedHosts: origin ? [new URL(origin).hostname] : [],
      proxy: { '/api': { target: env.FH_API || 'http://127.0.0.1:8810', ws: true }, ...phoneProxy(env) } },
    preview: { host: '127.0.0.1', port: 5183, strictPort: true },
    build: { outDir: 'dist', emptyOutDir: true },
    // css?raw 는 원문 그대로(시험이 배치·STOP 규칙과 브랜드 토큰 사본을 글자로 본다). 그냥 import 한 css 는 지금처럼 빈 값
    test: { environment: 'jsdom', setupFiles: ['src/tests/setup.ts'], css: { include: [/\.css\?raw$/] } },
  };
});
