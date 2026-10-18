import { useEffect, useState } from 'react';
import type { MapInfo } from '@contracts';
import { getMap, place } from '../data/maps';
import { useLink } from '../data/link';

// 시작할 지형의 그림만 읽는다. 보기 선택·시뮬 시작·조종 상태는 바꾸지 않는다.
// ver(10-18 저장 지도 시작): undefined = 기본 도면(새 지도 만들기 — 저장본 유무와 무관하게 기존 미리보기 관문 그대로 · 예고일 뿐 저장본 복원 아님) ·
//   '' = 저장 버전 미정(가져오기 0·실행 준비 아님) · 그 밖 = 그 world·층·map_source slam·map_version 정확히 같은 저장본만(없으면 오류 — GT 대체 0)
export function useTerrainPreview(w: string, f: string, catalog: MapInfo[] | string | null | undefined, enabled: boolean, reloadCatalog?: () => unknown, ver?: string) {
  const gen = useLink((s) => s.gen), provider = useLink((s) => s.provider), open = useLink((s) => s.open);
  const key = `${gen}|${provider}|${w}/${f}|${ver === undefined ? 'gt' : `v:${ver}`}`;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; src?: string; empty?: boolean; error?: string } | null>(null);
  useEffect(() => {
    setResult(null);
    if (!enabled || !w || !open || !Array.isArray(catalog)) return;
    let gone = false;
    if (ver === '') return;
    const m = catalog.find((x) => x.world_id === w && x.floor_id === f && (ver ? x.map_source === 'slam' && x.map_version === ver : x.map_source === 'gt_raster'));
    if (ver && !m) { setResult({ key, error: '고른 저장 지도가 목록에 없습니다' }); return; }
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
  return { ready: !!current && !error && (!!current.src || !!current.empty), src: current?.src, ver,
    empty: current?.empty, error, retry: () => { if (!Array.isArray(catalog)) reloadCatalog?.(); else setAttempt((n) => n + 1); } };
}

export function TerrainPreview({ w, f, preview }: { w: string; f: string; preview: ReturnType<typeof useTerrainPreview> }) {
  return <figure data-terrain-preview="" style={{ margin: 0, border: '1px solid var(--line2)', borderRadius: 8, overflow: 'hidden' }}>
    <div style={{ height: 128, display: 'grid', placeItems: 'center', background: preview.empty
      ? 'repeating-linear-gradient(0deg, transparent 0 15px, #71809620 15px 16px), repeating-linear-gradient(90deg, transparent 0 15px, #71809620 15px 16px)' : '#e9edf0' }}>
      {preview.src ? <img src={preview.src} alt={`${place(w, f)} ${preview.ver ? `저장한 지도 ${preview.ver}` : '기본 도면'} 2D 미리보기`} style={{ display: 'block', width: '100%', height: 128, objectFit: 'contain' }} />
        : <span role="status" style={{ padding: 12, textAlign: 'center', fontSize: 12, color: preview.empty ? 'var(--muted)' : '#334155' }}>
          {!w ? '지형을 고르면 2D 미리보기가 표시됩니다' : preview.error || (preview.empty ? '새 공간 · 실행 후 지도가 만들어집니다'
            : preview.ver === '' ? '저장한 지도를 정하면 그 그림이 표시됩니다(저장본이 없으면 그림 없음 — 기본 도면으로 대신하지 않음)' : '미리보기 불러오는 중…')}
        </span>}
    </div>
    <figcaption style={{ padding: '5px 8px', fontSize: 11, color: 'var(--muted)' }}>{w ? `${place(w, f)} · ${preview.ver ? `저장한 지도 ${preview.ver}(그림만 · 위치 없음)` : preview.ver != null ? '저장한 지도 미정' : preview.empty ? '기존 도면 없음' : '2D 미리보기 · 기본 도면'}` : '지형 미선택'}</figcaption>
    {w && preview.error && <button type="button" className="btn" onClick={preview.retry}>미리보기 다시 받기</button>}
  </figure>;
}
