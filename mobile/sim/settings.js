// Browser MuJoCo settings only. Bundled/offline sim never contacts the server.
export const DEFAULT_VX = 0.4, DEFAULT_WZ = 0.6, DEFAULT_VIEW_M = 12;
export const SETTINGS_TIMEOUT_MS = 2000;

export function boundedNumber(value, min, max, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

export function simSettings(org, caps = {}) {
  const o = org && typeof org === 'object' ? org : {};
  return {
    vx: boundedNumber(o.sim_runner_vx, 0.1, 1, DEFAULT_VX),
    wz: boundedNumber(o.sim_runner_wz, 0.1, 1, DEFAULT_WZ),
    caps: {
      vx: Math.min(boundedNumber(o.sim_max_vx, 0.2, 1, Infinity), boundedNumber(caps.vx, 0, 1, DEFAULT_VX)),
      wz: Math.min(boundedNumber(o.sim_max_wz, 0, 0.5, Infinity), boundedNumber(caps.wz, 0, 1, DEFAULT_WZ)),
    },
    viewRange: boundedNumber(o.lidar_view_m, 1, 30, DEFAULT_VIEW_M),
  };
}

// Reuse the web session at this origin; no cookie access, token, or cross-origin request.
// The timeout covers JSON too, even if a fetch implementation ignores abort.
export async function loadSimSettings(url, fetchSettings = globalThis.fetch, timeoutMs = SETTINGS_TIMEOUT_MS) {
  if (url.searchParams.get('from') !== 'web' || !['http:', 'https:'].includes(url.protocol)) return {};
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(async () => {
        const response = await fetchSettings('/api/v1/org/settings', {
          credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        });
        return response.ok ? await response.json() : {};
      }).catch(() => ({})),
      new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve({}); }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
