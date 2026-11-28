# 시안 원본 css

- `ui.css` · `pc.css` 는 승인된 시안의 공통 css 를 값 그대로 옮긴 것이다. 값을 고치지 않는다.
- 화면은 시안 화면 html 의 body 를 JSX 로 기계적으로 옮긴다. 태그 · 클래스 · 순서 · 글은 그대로 두고, 고정 글 자리만 서버 값으로 바꾼다.
- 화면마다의 `<style>` 은 그 화면 css 파일로 값 그대로 두고, 최상위 화면 클래스 한 겹만 씌운다.
- 사진 · 3D 모형 · 지도 그림은 저장소에 넣지 않는다. 개발 서버가 `FH_ASSET_DIR` 폴더를 `/proto-assets/` 로 내준다 (`localsim.js` `localAssets`).
- 앱에서는 `ui.pv.css` · `pc.pv.css` 를 쓴다. 원본의 모든 선택자 앞에 `.pv` 를 한 겹 씌운 사본이다 (`body` · `:root` 는 `.pv` 자체). 이식 화면의 최상위 틀에 `className="pv"` 를 단다. 원본이 바뀌면 사본도 같은 규칙으로 다시 만들고, `tests/protocss.test.js` 가 접두어 말고는 원본과 같은지 본다.
