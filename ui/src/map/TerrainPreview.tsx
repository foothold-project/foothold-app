import { useEffect, useState } from 'react';
import type { MapInfo } from '@contracts';
import { getMap, place } from '../data/maps';
import { useLink } from '../data/link';

// 시작할 지형의 기본 도면만 읽는다. 보기 선택·시뮬 시작·조종 상태는 바꾸지 않는다.
export function useTerrainPreview(w: string, f: string, catalog: MapInfo[] | string | null | undefined, enabled: boolean, reloadCatalog?: () => unknown) {
  const gen = useLink((s) => s.gen), provider = useLink((s) => s.provider), open = useLink((s) => s.open);
  const key = `${gen}|${provider}|${w}/${f}`;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; src?: string; empty?: boolean; error?: string } | null>(null);
  useEffect(() => {
    setResult(null);
    if (!enabled || !w || !open || !Array.isArray(catalog)) return;
    let gone = false;
    const m = catalog.find((x) => x.world_id === w && x.floor_id === f && x.map_source === 'gt_raster');
    if (!m) {
      setResult(w === 'rooms_a' ? { key, empty: true } : { key, error: '이 지형의 기본 도면이 없습니다' });
      return;
    }
    getMap(m).then((r) => {
      if (gone) return;
      setResult(typeof r === 'string' ? { key, error: r } : { key, src: (r.img as HTMLImageElement).src });
    }).catch(() => { if (!gone) setResult({ key, error: '미리보기를 불러오지 못했습니다' }); });
    return () => { gone = true; };
  }, [enabled, key, catalog, open, attempt]);
  const current = open && Array.isArray(catalog) && result?.key === key ? result : null;
  const error = typeof catalog === 'string' ? catalog : current?.error;
  return { ready: !!current && !error && (!!current.src || !!current.empty), src: current?.src,
    empty: current?.empty, error, retry: () => { if (!Array.isArray(catalog)) reloadCatalog?.(); else setAttempt((n) => n + 1); } };
}

export function TerrainPreview({ w, f, preview }: { w: string; f: string; preview: ReturnType<typeof useTerrainPreview> }) {
  return <figure data-terrain-preview="" style={{ margin: 0, border: '1px solid var(--line2)', borderRadius: 8, overflow: 'hidden' }}>
    <div style={{ height: 128, display: 'grid', placeItems: 'center', background: preview.empty
      ? 'repeating-linear-gradient(0deg, transparent 0 15px, #71809620 15px 16px), repeating-linear-gradient(90deg, transparent 0 15px, #71809620 15px 16px)' : '#e9edf0' }}>
      {preview.src ? <img src={preview.src} alt={`${place(w, f)} 2D 미리보기`} style={{ display: 'block', width: '100%', height: 128, objectFit: 'contain' }} />
        : <span role="status" style={{ padding: 12, textAlign: 'center', fontSize: 12, color: preview.empty ? 'var(--muted)' : '#334155' }}>
          {!w ? '지형을 고르면 2D 미리보기가 표시됩니다' : preview.error || (preview.empty ? '새 공간 · 실행 후 지도가 만들어집니다' : '미리보기 불러오는 중…')}
        </span>}
    </div>
    <figcaption style={{ padding: '5px 8px', fontSize: 11, color: 'var(--muted)' }}>{w ? `${place(w, f)} · ${preview.empty ? '기존 도면 없음' : '2D 미리보기'}` : '지형 미선택'}</figcaption>
    {w && preview.error && <button type="button" className="btn" onClick={preview.retry}>미리보기 다시 받기</button>}
  </figure>;
}
