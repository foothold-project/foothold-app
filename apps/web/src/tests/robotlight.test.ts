// 팀장 03:28 · 03:31 «로봇 라이팅이 어둠에 맞춰져 밝은 판에 안 어울림» · «밝은 판 점 아래 회색 바닥»: 판마다 나눈 로봇 라이팅 · 어둠 판은 옛 값 그대로
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { LIGHT_FLOOR, ROBOT_LIGHT_DARK, ROBOT_LIGHT_LIGHT_BASE, lightRobot, robotLight, robotLightOf } from '../proto/tileview';
import tileSrc from '../proto/tileview.ts?raw';
import go2Src from '../screens/u4/go2view.ts?raw';
import mapSrc from '../proto/u5map.tsx?raw';

describe('로봇 라이팅 판마다 따로', () => {
  it('어둠 = 옛 값(하늘 0.9 · 주광 2.2 · 테두리 민트 1.6 · 파랑 0.8 · 노출 1.05 · 옛 값)', () => {
    const hemi = new THREE.HemisphereLight(), key = new THREE.DirectionalLight(), a = new THREE.DirectionalLight(), b = new THREE.DirectionalLight();
    const k = lightRobot(false, hemi, key, [[a, 1.6, 0x00c389], [b, 0.8, 0x4c9bff]]);
    expect(k).toBe(ROBOT_LIGHT_DARK); expect([hemi.intensity, key.intensity, a.intensity, b.intensity]).toEqual([0.9, 2.2, 1.6, 0.8]);
    expect([hemi.color.getHex(), hemi.groundColor.getHex(), a.color.getHex(), b.color.getHex()]).toEqual([0xdfe8f0, 0x0c0f14, 0x00c389, 0x4c9bff]);
    expect(k.exp).toBe(1.05);
  });
  it('밝음 = 하늘 빛 낮춤 · 주광 올림 · 테두리는 흰 빛 조금 · 주소 ?rl= 로 견주기', () => {
    const l = robotLight(true);
    expect(l.hemi).toBeLessThan(2.4); expect(l.key).toBeGreaterThan(ROBOT_LIGHT_DARK.key);
    const hemi = new THREE.HemisphereLight(), key = new THREE.DirectionalLight(), a = new THREE.DirectionalLight();
    lightRobot(true, hemi, key, [[a, 1.6, 0x00c389]]); expect(a.color.getHex()).toBe(0xffffff); expect(a.intensity).toBeCloseTo(1.6 * l.rim, 6);
    expect(robotLightOf('?rl=1,3,0.5,0.95')).toEqual({ ...ROBOT_LIGHT_LIGHT_BASE, hemi: 1, key: 3, rim: 0.5, exp: 0.95 });
    expect(robotLightOf('rl=1,2')).toBe(ROBOT_LIGHT_LIGHT_BASE);
  });
  it('관제 타일(점 바닥) · 로봇 탭 · 지도 보기 로봇이 같은 함수 · 밝은 판 회색 바닥은 #5E6662 점과 같은 흐림', () => {
    expect(tileSrc).toContain('rl = lightRobot(light, this.hemi, this.key, this.rims)');
    expect(go2Src).toContain('const k = lightRobot(l, hemi, key, rims); r.toneMappingExposure = k.exp;');
    expect(mapSrc).toContain('const k = robotLight(true);');
    expect(LIGHT_FLOOR.col).toBe(0x5e6662);
    expect(tileSrc).toContain("uniforms.op.value = light && ly.dots ? LIGHT_FLOOR.op : 0;");
    expect(tileSrc).toContain('1.0-smoothstep(0.35,1.9,length(u))');
  });
});

describe('충전 · 점검 로봇 몸 회색(테두리 빛 뺌 · 04:05)', () => {
  it('기본 grey: 테두리 빛 0 · 하늘 빛 PAD_GREY 배 · ?padBody=lit 이면 그대로 · 바닥 표시 없으면 그대로', async () => {
    const { greyPadBody, padBodyOf, PAD_GREY } = await import('../proto/tileview');
    const mk = () => { const h = new THREE.HemisphereLight(), k = new THREE.DirectionalLight(), a = new THREE.DirectionalLight(); const rims: [THREE.DirectionalLight, number, number][] = [[a, 1.6, 0x00c389]]; lightRobot(false, h, k, rims); return { h, a, rims }; };
    let x = mk(); greyPadBody(true, x.h, x.rims, 'grey'); expect(x.a.intensity).toBe(0); expect(x.h.intensity).toBeCloseTo(0.9 * PAD_GREY.hemi, 6);
    x = mk(); greyPadBody(true, x.h, x.rims, 'lit'); expect(x.a.intensity).toBe(1.6);
    x = mk(); greyPadBody(false, x.h, x.rims, 'grey'); expect(x.a.intensity).toBe(1.6);
    expect(padBodyOf('?padBody=lit')).toBe('lit'); expect(padBodyOf('')).toBe('grey');
    expect(tileSrc).toContain('greyPadBody(!!look.pad && !look.cyber'); expect(go2Src).toContain('greyPadBody(!!api.pad && !opt.cyber');
  });
});

it('밝은 판 회색 바닥 진하기 견주기 ?floor=', async () => {
  const { floorOpOf } = await import('../proto/tileview');
  expect(floorOpOf('?floor=0.24')).toBe(0.24); expect(floorOpOf('')).toBe(0.32); expect(floorOpOf('?floor=x')).toBe(0.32); expect(floorOpOf('?floor=2')).toBe(0.32);
});
