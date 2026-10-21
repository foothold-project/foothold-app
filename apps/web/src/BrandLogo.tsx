// 공식 FOOTHOLD 로고(foothold-brand 7afd241, public/brand). 원본 SVG 를 <img> 로 그대로 쓴다 —
// 글자로 다시 그리지 않고, transform·filter·재색칠 없음(3° 기울기는 SVG 안에 이미 있음). 높이만 주고 너비는 비율대로.
// tone 없음 = 화면 테마를 따라 dark/light 파일 중 하나만 보임. tone 지정 = 바탕이 항상 그 색인 곳(로그인 소개면 등).
const SRC = `${import.meta.env.BASE_URL}brand/assets/logo/v1/foothold-lockup-`;
type Tone = 'dark' | 'light';

export function BrandLogo({ kind = 'compact', h, tone }: { kind?: 'compact' | 'primary'; h: number; tone?: Tone }) {
  const img = (t: Tone) => <img data-brand className={t === 'dark' ? 'fh-logo-d' : 'fh-logo-l'} src={`${SRC}${kind}-${t}.svg`} alt="FOOTHOLD" style={{ height: h }} />;
  return <span data-brand-box data-tone={tone}>{tone ? img(tone) : <>{img('dark')}{img('light')}</>}</span>;
}
