// 화면 틀의 테마(.fh = 어두움, .fh.light = 밝음)를 <html data-theme> 로 옮긴다.
// 공식 토큰 CSS 가 :root[data-theme] 로 값을 고르기 때문. .fh 가 없는 화면(Report, 인쇄용)은 밝음.
// MutationObserver 콜백은 마이크로태스크라 그리기 전에 반영된다.
export function syncTheme() {
  const set = () => {
    const fh = document.querySelector('.fh'), t = !fh || fh.classList.contains('light') ? 'light' : 'dark';
    if (document.documentElement.dataset.theme !== t) document.documentElement.dataset.theme = t;
  };
  new MutationObserver(set).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  set();
}
