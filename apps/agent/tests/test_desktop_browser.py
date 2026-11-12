"""App activation and server navigation, all OS/browser effects replaced by fakes."""
import asyncio
import re
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

from foothold_agent.desktop import browser
from foothold_agent.desktop import __main__ as desktop
from foothold_agent.setup.view import PAGE, Status


@pytest.fixture(autouse=True)
def no_real_window_access(monkeypatch):
    monkeypatch.setattr(browser, 'focus_existing', lambda _: False)
    monkeypatch.delenv('DISPLAY', raising=False)


@pytest.mark.parametrize('available,expected', [
    ({'google-chrome', 'chromium', 'microsoft-edge'}, 'google-chrome'),
    ({'google-chrome-stable', 'chromium'}, 'google-chrome-stable'),
    ({'chromium', 'microsoft-edge'}, 'chromium'),
    ({'chromium-browser', 'microsoft-edge'}, 'chromium-browser'),
    ({'/snap/bin/chromium', 'microsoft-edge'}, '/snap/bin/chromium'),
    ({'microsoft-edge'}, 'microsoft-edge'),
    ({'microsoft-edge-stable'}, 'microsoft-edge-stable'),
    (set(), None),
])
def test_linux_browser_preference(monkeypatch, available, expected):
    monkeypatch.setattr(browser.shutil, 'which', lambda name: name if name in available else None)
    assert browser.find_browser() == expected


def test_app_command_is_local_only_and_profile_is_separate(tmp_path, monkeypatch):
    monkeypatch.setenv('XDG_CACHE_HOME', str(tmp_path))
    monkeypatch.setattr(browser, 'find_browser', lambda: '/usr/bin/chromium')
    calls = []
    monkeypatch.setattr(browser.subprocess, 'Popen', lambda argv, **kw: calls.append((argv, kw)))
    assert browser.open_window('http://127.0.0.1:12345')
    argv, options = calls[0]
    assert argv == ['/usr/bin/chromium', '--app=http://127.0.0.1:12345', '--window-size=720,820',
                    '--user-data-dir='+str(tmp_path/'foothold/browser-profile'),
                    '--no-first-run', '--no-default-browser-check']
    assert not options.get('shell')
    assert (tmp_path/'foothold/browser-profile').stat().st_mode & 0o777 == 0o700


@pytest.mark.parametrize('fail_launch', [False, True])
def test_missing_or_unlaunchable_browser_falls_back_to_default(monkeypatch, fail_launch, tmp_path):
    monkeypatch.setenv('XDG_CACHE_HOME', str(tmp_path))
    monkeypatch.setattr(browser, 'find_browser', lambda: '/missing/chrome' if fail_launch else None)
    def fail(*args, **kwargs):
        raise FileNotFoundError()
    monkeypatch.setattr(browser.subprocess, 'Popen', fail)
    calls = []
    monkeypatch.setattr(browser.webbrowser, 'open', lambda url: calls.append(url) or True)
    assert browser.open_window('http://127.0.0.1:12345')
    assert calls == ['http://127.0.0.1:12345']


def test_windows_edge_default_install_and_app_command(tmp_path, monkeypatch):
    env = {'ProgramFiles(x86)':str(tmp_path/'programs'), 'LOCALAPPDATA':str(tmp_path/'local')}
    monkeypatch.setattr(browser, 'os', NS(name='nt', environ=env))
    monkeypatch.setattr(browser.shutil, 'which', lambda _: None)
    edge = tmp_path/'programs/Microsoft/Edge/Application/msedge.exe'
    edge.parent.mkdir(parents=True)
    edge.write_bytes(b'fake Edge')
    calls = []
    monkeypatch.setattr(browser.subprocess, 'Popen', lambda argv, **kw: calls.append(argv))
    assert browser.open_window('http://127.0.0.1:12345')
    assert calls[0][0] == str(edge)
    assert '--app=http://127.0.0.1:12345' in calls[0]
    assert '--user-data-dir='+str(tmp_path/'local/foothold/cache/browser-profile') in calls[0]
    edge.unlink()
    assert browser.find_browser() is None
    monkeypatch.setattr(browser.shutil, 'which', lambda name: 'path-edge' if name == 'msedge' else None)
    assert browser.find_browser() == 'path-edge'


@pytest.mark.parametrize('url', ['https://server.invalid', 'http://user:secret@127.0.0.1:12345',
                                'http://127.0.0.1:12345/?token=secret', 'http://127.0.0.1:12345/private'])
def test_app_command_rejects_nonlocal_or_secret_urls(url):
    with pytest.raises(ValueError):
        browser.open_window(url)


def test_server_button_uses_only_configured_https_origin_in_default_browser(monkeypatch):
    calls = []
    monkeypatch.setattr(desktop.webbrowser, 'open', lambda url: calls.append(url))
    monkeypatch.setattr(desktop, 'autostart_enabled', lambda: True)
    status = Status()
    controls = desktop.Controls(status=status, server='https://control.example.invalid:444/')
    assert not controls.snapshot()['server_web_available']
    with pytest.raises(PermissionError):
        controls.action({'action':'server-web'})
    status.update(connected=True)
    assert controls.snapshot()['server_web_available']
    assert 'server' not in controls.snapshot()  # no browser-provided URL
    controls.action({'action':'server-web'})
    assert calls == ['https://control.example.invalid:444']
    with pytest.raises(ValueError):
        controls.action({'action':'server-web', 'url':'https://evil.invalid'})
    status.update(connected=False)
    with pytest.raises(PermissionError):
        controls.action({'action':'server-web'})
    assert len(calls) == 1


@pytest.mark.parametrize('value', ['http://127.0.0.1', 'http://example.invalid',
    'https://example.invalid/private', 'https://example.invalid/?token=secret',
    'https://user:secret@example.invalid', 'https://example.invalid/#secret',
    'https://example.invalid:bad', 'https://example.invalid:99999',
    'https://example.invalid\\@evil.invalid', 'https://exa\nmple.invalid'])
def test_untrusted_server_configuration_never_opens_browser(value):
    with pytest.raises(ValueError):
        desktop.Controls(status=Status(), server=value)


@pytest.mark.parametrize('link', ['foothold-robot://open', 'foothold-robot://other?token=ignored',
                                 'https://evil.invalid', '--repair'])
def test_protocol_payload_only_activates_already_running_service(monkeypatch, link):
    monkeypatch.setattr(desktop.sys, 'executable', '/opt/foothold-robot/python/bin/python3')
    calls = []
    monkeypatch.setattr(desktop.subprocess, 'run', lambda argv, **kw: calls.append(argv) or NS(returncode=0))
    monkeypatch.setattr(desktop, 'open_window', lambda url: calls.append(url))
    assert desktop.main(['--protocol', link, '--repair', '--nic', 'injected', '--no-browser']) == 0
    assert calls == [
        ['systemctl','--user','is-active','--quiet','foothold-robot.service'],
        ['systemctl','--user','start','foothold-robot.service'], 'http://127.0.0.1:9611']


def test_repeated_icon_launch_only_opens_existing_listener(tmp_path, monkeypatch):
    from foothold_agent.desktop import locking
    root = tmp_path/'installation'
    executable = root/'python/bin/python3'
    executable.parent.mkdir(parents=True)
    (root/'server.json').write_text('{"server":"https://control.example.invalid"}')
    monkeypatch.setenv('XDG_CACHE_HOME', str(tmp_path/'state'))
    monkeypatch.setattr(desktop.sys, 'executable', str(executable))
    monkeypatch.setattr(desktop, 'default_path', lambda: tmp_path/'private/agent.json')
    class AlreadyRunning:
        def __init__(self, *_): pass
        def __enter__(self): raise BlockingIOError()
    monkeypatch.setattr(locking, 'InstanceLock', AlreadyRunning)
    calls = []
    monkeypatch.setattr(desktop, 'open_window', lambda url: calls.append(url))
    monkeypatch.setattr(desktop, 'make_server', lambda *a, **k: pytest.fail('must not bind a second listener'))
    assert desktop.main(['--protocol', 'foothold-robot://open']) == 0
    assert calls == ['http://127.0.0.1:9611']


def test_setup_entrypoint_opens_app_window_on_temporary_port(tmp_path, monkeypatch):
    from foothold_agent.setup import __main__ as setup
    calls = []
    monkeypatch.setattr(browser, 'open_window', lambda url: calls.append(url))
    async def fake_serve(*args): return True
    monkeypatch.setattr(setup, 'serve', fake_serve)
    assert setup.main(['--port','0','--config',str(tmp_path/'private/agent.json')]) == 0
    assert len(calls) == 1 and calls[0].startswith('http://127.0.0.1:')
    assert calls[0] != 'http://127.0.0.1:9611'


def test_screen_copy_and_manual_details():
    assert '웹 + 로봇 연결하기 → 새 로봇 추가 → 노트북 화면의 코드 넣기 → 이름' in PAGE
    for old in ('같은 기체번호 확인', '조종권 획득', '실측 정지', '잠금 해제', '새 중립 입력'):
        assert old not in PAGE
    assert '<details><summary>직접 설정하는 법</summary>' in PAGE
    before, details = PAGE.split('<details>', 1)
    manual, after = details.split('</details>', 1)
    for technical in ('192.168.123.200~254', '게이트웨이·DNS', '기본 경로'):
        assert technical in manual
        assert technical not in before+after
    status = Status()
    status.update(mode='승인됨 · 조종권과 잠금 해제 필요')
    assert status.snapshot()['mode'] == '연결 준비 완료 · 웹에서 조종을 시작하고 움직임을 허용하세요'


def test_snap_profile_stays_in_snap_state(tmp_path, monkeypatch):
    monkeypatch.setattr(browser, 'find_browser', lambda: '/snap/bin/chromium')
    exists = Path.exists
    monkeypatch.setattr(Path, 'exists', lambda self: True if str(self) == '/snap/bin/chromium' else exists(self))
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    calls = []
    monkeypatch.setattr(browser.subprocess, 'Popen', lambda argv, **kw: calls.append(argv))
    browser.open_window('http://127.0.0.1:12345')
    assert '--user-data-dir='+str(tmp_path/'snap/chromium/common/foothold/cache/browser-profile') in calls[0]


def test_server_navigation_requires_local_origin_and_connection(tmp_path, monkeypatch):
    import json
    import threading
    from urllib.error import HTTPError
    from urllib.request import Request, urlopen
    from foothold_agent.setup.view import make_server
    monkeypatch.setattr(desktop, 'autostart_enabled', lambda: True)
    opened = []
    monkeypatch.setattr(desktop.webbrowser, 'open', lambda url: opened.append(url))
    status = Status()
    controls = desktop.Controls(status=status, server='https://control.example.invalid/')
    server = make_server(status, 0, controls=controls)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    base = f'http://127.0.0.1:{server.server_port}'
    def post(body, origin=base):
        return urlopen(Request(base+'/action', data=json.dumps(body).encode(),
                               headers={'Origin':origin, 'Content-Type':'application/json'}))
    try:
        with pytest.raises(HTTPError) as error:
            post({'action':'server-web'})
        assert error.value.code == 400
        status.update(connected=True)
        with pytest.raises(HTTPError) as error:
            post({'action':'server-web'}, 'https://evil.invalid')
        assert error.value.code == 403
        with pytest.raises(HTTPError):
            post({'action':'server-web', 'url':'https://evil.invalid'})
        assert opened == []
        with post({'action':'server-web'}) as response:
            assert response.status == 204
        assert opened == ['https://control.example.invalid']
    finally:
        server.shutdown()
        server.server_close()
        worker.join()


def test_existing_window_is_raised_without_a_new_browser_process(monkeypatch):
    monkeypatch.setattr(browser, 'find_browser', lambda: '/usr/bin/chromium')
    ports = []
    monkeypatch.setattr(browser, 'focus_existing', lambda port: ports.append(port) or True)
    monkeypatch.setattr(browser.subprocess, 'Popen', lambda *a, **k: pytest.fail('existing window must be reused'))
    assert browser.open_window('http://127.0.0.1:12345')
    assert ports == [12345]


def test_linux_window_class_is_scoped_to_the_setup_port(tmp_path, monkeypatch):
    monkeypatch.setenv('DISPLAY', ':fake')
    monkeypatch.setenv('XDG_CACHE_HOME', str(tmp_path))
    monkeypatch.setattr(browser, 'find_browser', lambda: '/usr/bin/google-chrome')
    calls = []
    monkeypatch.setattr(browser.subprocess, 'Popen', lambda argv, **kw: calls.append(argv))
    browser.open_window('http://127.0.0.1:12345')
    assert '--class=foothold-robot-12345' in calls[0]
    assert '--ozone-platform=x11' in calls[0]


def test_window_focus_uses_only_os_libraries_and_missing_display_falls_back(monkeypatch):
    from foothold_agent.desktop import window
    assert not window._x11('foothold-robot-12345')
    calls = []
    monkeypatch.setattr(window, '_x11', lambda name: calls.append(name) or True)
    assert window.focus_existing(12345)
    assert calls == ['foothold-robot-12345']
    def missing(_): raise OSError('no X11 library')
    monkeypatch.setattr(window, '_x11', missing)
    assert not window.focus_existing(12345)


def test_windows_existing_app_restores_and_focuses_without_browser_tabs(monkeypatch):
    import ctypes as C
    from foothold_agent.desktop import window
    called = []
    class Function:
        def __init__(self, fn): self.fn = fn
        def __call__(self, *args): return self.fn(*args)
    def title(handle, text, size):
        text.value = window.TITLE+' - Microsoft Edge' if handle == 1 else window.TITLE
        return len(text.value)
    def kind(handle, text, size):
        text.value = 'Chrome_WidgetWin_1'
        return len(text.value)
    def enumerate_windows(callback, value):
        assert callback(1, value)  # ordinary browser tab title must not match
        assert not callback(2, value)
        return True
    fake = NS(GetWindowTextW=Function(title), GetClassNameW=Function(kind),
              ShowWindow=Function(lambda *args: called.append(('restore',args))),
              SetForegroundWindow=Function(lambda *args: called.append(('focus',args))),
              EnumWindows=Function(enumerate_windows))
    monkeypatch.setattr(C, 'WinDLL', lambda *a, **k: fake, raising=False)
    monkeypatch.setattr(C, 'WINFUNCTYPE', C.CFUNCTYPE, raising=False)
    assert window._windows()
    assert called == [('restore',(2,9)), ('focus',(2,))]


def test_window_uses_web_brand_tokens_and_defaults_dark():
    from foothold_agent.setup.view import TOKENS
    web = (Path(__file__).parents[2]/'web/public/brand/tokens/foothold.tokens.css').read_text(encoding='utf-8')
    assert web.endswith(TOKENS) and TOKENS.startswith(':root[data-theme="dark"]{') and ':root[data-theme="light"]{' in TOKENS
    assert TOKENS in PAGE and '<html lang="ko" data-theme="dark">' in PAGE
    styles = PAGE.replace(TOKENS, '')
    assert 'http' not in styles and '@import' not in styles and 'url(' not in styles
    assert not re.findall(r'#[0-9a-f]{6}\b', styles), '색은 토큰으로만(QR 흰 바탕 #fff 제외)'
    for value, name in (('dark', '어두움'), ('light', '밝음'), ('system', '기기 설정 따름')):
        assert f'<option value="{value}">{name}</option>' in PAGE
    assert "localStorage.getItem('fh.theme')" in PAGE and ':focus-visible{outline:3px solid var(--brand)' in PAGE
