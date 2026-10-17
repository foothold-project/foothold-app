"""take_photo(sim/v2_link.py main() 안 중첩 함수) 회귀 — ROS·tornado 없이, 실제 함수 본문을 AST 로 꺼내 실제 cam_why·Core·Media 로 돌린다.
사용: python3 tools/take_photo_check.py            → 작업트리 수정판 PASS 기대
      python3 tools/take_photo_check.py --orig <원판 v2_link.py 사본>  → 원판 성공 경로 NameError('st') 재현 기대
namespace 에 st 를 넣지 않는다(넣으면 원판 결함을 가린다). 사진·사건은 mktemp 임시 Media 에만 쓴다."""
import ast, json, os, sys, tempfile, textwrap, time
from pathlib import Path
from types import SimpleNamespace

sys.dont_write_bytecode = True   # 저장소에 __pycache__ 를 남기지 않음
REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'sim'))
import v2_link as L  # noqa: E402  (main() 은 부르지 않음 — import 만으로 ROS 불필요)

JPEG = b'\xff\xd8\xff\xe0' + b'fake-frame' * 10 + b'\xff\xd9'


def load_take_photo(path, ns):
    """path 의 main() 안 def take_photo 원문 그대로 compile → ns 를 전역으로 쓰는 함수"""
    src = Path(path).read_text(encoding='utf-8')
    main = next(n for n in ast.parse(src).body if isinstance(n, ast.FunctionDef) and n.name == 'main')
    fn = [n for n in ast.walk(main) if isinstance(n, ast.FunctionDef) and n.name == 'take_photo']
    assert len(fn) == 1, f'take_photo {len(fn)}개'
    exec(compile(textwrap.dedent(ast.get_source_segment(src, fn[0])), path, 'exec'), ns)
    assert 'st' not in ns, 'st 주입 금지'
    return ns['take_photo']


def rig(path, root):
    """실제 Core(가짜 시계)·실제 Media(임시 폴더)·실제 cam_why. 반환: (take_photo, 상태 넣기, 시계, 응답 목록, core, sim, media)"""
    t = [100.0]
    core = L.Core(now=lambda: t[0]); media = L.Media(root); core.sink = media.event
    sim = {'jpeg': None, 'jpeg_t': None, 'jpeg_n': 0, 'jpeg_wall': None, 'jpeg_stamp': None, 'jpeg_ep': None, 'jpeg_reset': False}
    replies = []
    clock = SimpleNamespace(monotonic=lambda: t[0], strftime=time.strftime, localtime=time.localtime)
    ns = {'time': clock, 'lock': __import__('threading').Lock(), 'photo_last': [0.0], 'sim': sim, 'core': core, 'media': media,
          'cam_why': L.cam_why, 'reply': lambda c, rid, ok, text, **kw: replies.append((rid, ok, text, kw))}
    tp = load_take_photo(path, ns)

    def state(ep, rip=False):
        core.on_state({'schema': L.SCHEMA, 'episode': ep, 'stop_requested': True, 'reset_in_progress': rip, 'policy_running': True,
                       'source': 'gazebo_gt', 'x': 1.25, 'y': -0.5, 'yaw': 0.75})

    def frame():        # 프레임 받기 = 서버의 sim 갱신과 같은 칸
        sim.update(jpeg=JPEG, jpeg_t=t[0], jpeg_wall=time.time(), jpeg_stamp=12.5, jpeg_ep=core.episode,
                   jpeg_reset=bool(core.reset_pending or (core.st or {}).get('reset_in_progress')))
    return tp, state, frame, t, replies, core, sim, media


def files(root):
    r = Path(root)
    return (sorted(p.relative_to(r).as_posix() for p in (r / 'photos').rglob('*') if p.is_file()),
            (r / 'photos.jsonl').read_text(encoding='utf-8').splitlines() if (r / 'photos.jsonl').exists() else [],
            [json.loads(l)['text'] for l in (r / 'events.jsonl').read_text(encoding='utf-8').splitlines()] if (r / 'events.jsonl').exists() else [])


def ready(path, root):
    """성공 조건: episode 3 상태 → 1 s 넘게 지난 뒤 새 상태·새 프레임(같은 회차·리셋 아님)"""
    tp, state, frame, t, rp, core, sim, media = rig(path, root)
    state(3); t[0] += 1.5; state(3); frame()
    return tp, state, frame, t, rp, core, sim, media


C = SimpleNamespace(actor='tester')


def check_orig(path):
    with tempfile.TemporaryDirectory() as d:
        tp, *_ = ready(path, d)
        try:
            tp(C, 'r1')
        except NameError as e:
            assert "'st'" in str(e), e
            print(f'ORIG_NAMEERROR_OK {e}')
        else:
            raise AssertionError('원판에서 NameError 가 안 남 — 원판 경로 확인')
        ph, pj, ev = files(d)
        assert ph == [] and pj == [] and not any('사진 저장' in x for x in ev), (ph, pj, ev)


def check_fixed(path):
    n = 0
    with tempfile.TemporaryDirectory() as d:                      # 성공: jpeg 바이트·photos.jsonl·reply·성공 사건
        tp, state, frame, t, rp, core, sim, media = ready(path, d)
        tp(C, 'r1')
        rid, ok, text, kw = rp[-1]
        assert (rid, ok, text) == ('r1', True, '사진 서버 저장'), rp
        m = kw['photo']
        assert (m['source'], m['x'], m['y'], m['yaw'], m['episode'], m['by'], m['frame_stamp_sim_s']) == ('gazebo_gt', 1.25, -0.5, 0.75, 3, 'tester', 12.5), m
        assert m['gt_age_s'] == 0.0 and m['bytes'] == len(JPEG), m
        ph, pj, ev = files(d)
        assert len(ph) == 1 and (Path(d) / ph[0]).read_bytes() == JPEG and m['url'] == 'media/' + ph[0], (ph, m)
        assert len(pj) == 1 and json.loads(pj[0]) == m, pj
        assert sum('사진 저장 · tester · episode 3' in x for x in ev) == 1, ev
        assert not list(Path(d, 'photos').rglob('*.tmp')); n += 1

    def refused(name, setup, want):
        with tempfile.TemporaryDirectory() as d:
            tp, state, frame, t, rp, core, sim, media = ready(path, d)
            setup(state, frame, t, core, sim)
            tp(C, 'rx')
            rid, ok, text, kw = rp[-1]
            assert ok is False and want in text and 'photo' not in kw, (name, rp)
            ph, pj, ev = files(d)
            assert ph == [] and pj == [] and not any('사진 저장' in x for x in ev), (name, ph, pj, ev)
            print(f'REFUSE_OK {name}: {text}')

    def no_status(state, frame, t, core, sim):          # 상태 한 번도 없음(프레임은 있음)
        core.st = None; core.state_t = None
    refused('status 없음', no_status, '시뮬 상태 없음')

    def stale(state, frame, t, core, sim):              # 상태 1 s 넘게 끊김 + 프레임은 새것
        t[0] += 1.2; frame()
    refused('status 오래됨', stale, '시뮬 상태 없음')

    def resetting(state, frame, t, core, sim):          # 리셋 중 상태
        t[0] += 0.1; state(3, rip=True)
    refused('reset 중', resetting, '리셋 중')

    def ep_mismatch(state, frame, t, core, sim):        # 프레임은 옛 회차(3), 지금은 4
        t[0] += 0.1; state(4)
    refused('episode 불일치', ep_mismatch, 'episode')
    n += 4

    with tempfile.TemporaryDirectory() as d:                      # 파일 OSError: 오늘 날짜 폴더 자리에 파일 → mkdir FileExistsError
        tp, state, frame, t, rp, core, sim, media = ready(path, d)
        (Path(d) / 'photos' / time.strftime('%Y%m%d')).write_text('x')
        tp(C, 'r2')
        rid, ok, text, kw = rp[-1]
        assert (rid, ok) == ('r2', False) and text == '사진 저장 실패 · FileExistsError' and 'photo' not in kw, rp
        ph, pj, ev = files(d)
        assert ph == ['photos/' + time.strftime('%Y%m%d')] and pj == [] and not any('사진 저장 ·' in x for x in ev), (ph, pj, ev)
        print(f'REFUSE_OK 파일 OSError: {text}'); n += 1
    print(f'TAKE_PHOTO_OK {n} (성공 1 · 거부 4 · OSError 1) {path}')


if __name__ == '__main__':
    if sys.argv[1:2] == ['--orig']:
        check_orig(sys.argv[2])
    else:
        check_fixed(str(REPO / 'sim' / 'v2_link.py'))
