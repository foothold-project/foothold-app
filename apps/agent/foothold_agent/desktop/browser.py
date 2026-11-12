"""Dependency-free app window launcher; never uses the personal browser profile."""
import os
from pathlib import Path
import shutil
import subprocess
import webbrowser
from urllib.parse import urlsplit

from foothold_agent.setup.pairing import origin
from .window import focus_existing, window_class


def state_dir():
    if os.name == 'nt':
        return Path(os.environ['LOCALAPPDATA'])/'foothold/cache'
    return Path(os.environ.get('XDG_CACHE_HOME', Path.home()/'.cache'))/'foothold'


def find_browser():
    if os.name == 'nt':
        found = shutil.which('msedge')
        if found:
            return found
        for name in ('ProgramFiles(x86)', 'ProgramFiles', 'LOCALAPPDATA'):
            if os.environ.get(name):
                path = Path(os.environ[name])/'Microsoft/Edge/Application/msedge.exe'
                if path.is_file():
                    return str(path)
        return None
    for name in ('google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
                 '/snap/bin/chromium', 'microsoft-edge', 'microsoft-edge-stable'):
        found = shutil.which(name)
        if found:
            return found
    return None


def open_window(url):
    parsed = urlsplit(url)
    if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or not parsed.port
            or parsed.username or parsed.password or parsed.path not in ('', '/')
            or parsed.query or parsed.fragment):
        raise ValueError('local connection screen required')
    browser = find_browser()
    if browser:
        if focus_existing(parsed.port):
            return True
        try:
            # Ubuntu's chromium/snap wrapper cannot access another app's
            # hidden cache. Keep its dedicated state inside the snap sandbox.
            snap = (os.name != 'nt' and Path(browser).name in ('chromium', 'chromium-browser')
                    and Path('/snap/bin/chromium').exists())
            cache = Path.home()/'snap/chromium/common/foothold/cache' if snap else state_dir()
            profile = cache/'browser-profile'
            profile.mkdir(mode=0o700, parents=True, exist_ok=True)
            platform = (['--class='+window_class(parsed.port), '--ozone-platform=x11']
                        if os.name != 'nt' and os.environ.get('DISPLAY') else [])
            subprocess.Popen([browser, '--app='+url, '--window-size=720,820',
                              '--user-data-dir='+str(profile), '--no-first-run',
                              '--no-default-browser-check', *platform],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
            return True
        except OSError:
            pass
    return webbrowser.open(url)


def server_origin(value):
    """Only the installer-provided HTTPS origin may reach the default browser."""
    if not isinstance(value, str) or '\\' in value or any(c.isspace() or ord(c) < 32 for c in value):
        raise ValueError('HTTPS server origin required')
    result = origin(value)
    parsed = urlsplit(result)
    if parsed.scheme != 'https':
        raise ValueError('HTTPS server origin required')
    parsed.port  # Reject invalid/out-of-range port syntax before any browser call.
    return result
