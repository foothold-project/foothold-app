// Browser MuJoCo settings only. Bundled/offline sim never contacts the server.
export const DEFAULT_VX = 0.4, DEFAULT_WZ = 0.6, DEFAULT_VIEW_M = 12;
export const SETTINGS_TIMEOUT_MS = 2000;

export function boundedNumber(value, min, max, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

export function effectiveSettings(org, modeId) {
  const o = org && typeof org === 'object' ? org : {};
  const id = modeId === 'foothold-v2' ? 'nvidia-demo' : modeId;
  return { ...o, ...(id && o.model_overrides?.[id]) };
}

export function simSettings(org, caps = {}, modeId) {
  const o = effectiveSettings(org, modeId);
  const turnCap = boundedNumber(caps.wz, 0, 1.2, 1);
  return {
    vx: boundedNumber(o.sim_runner_vx, 0.1, 1.5, DEFAULT_VX),
    wz: boundedNumber(o.sim_runner_wz, 0.1, turnCap, DEFAULT_WZ),
    caps: {
      vx: Math.min(boundedNumber(o.sim_max_vx, 0.2, 1.5, Infinity), boundedNumber(caps.vx, 0, 1.5, DEFAULT_VX)),
      wz: Math.min(boundedNumber(o.sim_max_wz, 0, 1.2, Infinity), boundedNumber(caps.wz, 0, 1.2, DEFAULT_WZ)),
    },
    viewRange: boundedNumber(o.lidar_view_m, 1, 30, DEFAULT_VIEW_M),
  };
}

// Reuse the web session at this origin; no cookie access, token, or cross-origin request.
// The timeout covers JSON too, even if a fetch implementation ignores abort.
export async function loadSimSettings(url, fetchSettings = globalThis.fetch, timeoutMs = SETTINGS_TIMEOUT_MS, fallback = {}) {
  if (url.searchParams.get('from') !== 'web' || !['http:', 'https:'].includes(url.protocol)) return fallback;
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(async () => {
        const response = await fetchSettings('/api/v1/org/settings', {
          credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        });
        return response.ok ? await response.json() : fallback;
      }).catch(() => fallback),
      new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(fallback); }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
