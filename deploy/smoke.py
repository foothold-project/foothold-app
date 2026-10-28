"""Real TLS/HTTP/WS probes; no robot commands, never print credential data."""
import http.cookiejar
import json
import os
from pathlib import Path
import shlex
import stat
import time
from urllib.error import HTTPError
from urllib.request import Request, build_opener, ProxyHandler, HTTPCookieProcessor, HTTPRedirectHandler
from websockets.sync.client import connect


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def private_env(path):
    info = path.stat()
    if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError('Private smoke input requires root:600')
    return dict(line.split('=', 1) for line in shlex.split(path.read_text()))


def main():
    site = private_env(Path('/etc/foothold/site.env'))['FH_SITE']
    origin = 'https://' + site
    jar = http.cookiejar.CookieJar()
    opener = build_opener(ProxyHandler({}), NoRedirect(), HTTPCookieProcessor(jar))
    # Retry only readiness. Login is attempted once to avoid failure-rate floods.
    for attempt in range(20):
        try:
            with opener.open(origin + '/', timeout=5) as response:
                assert response.status == 200 and b'<html' in response.read(65536).lower()
            try:
                opener.open(origin + '/api/v1/auth/session', timeout=5)
            except HTTPError as error:
                assert error.code == 401
            else:
                raise ValueError('Unauthenticated session must be 401')
            break
        except Exception:
            if attempt == 19:
                raise
            time.sleep(2)
    # After initial password rotation supply a current web cookie in a root:600
    # /root/foothold-smoke.env containing FH_SMOKE_COOKIE, never a CLI value.
    existing = Path('/root/foothold-smoke.env')
    owned_session = not existing.exists()
    csrf = None
    if owned_session:
        admin = private_env(Path('/root/foothold-initial-admin.txt'))
        request = Request(origin + '/api/v1/auth/login', method='POST',
                          data=json.dumps({'username': admin['FH_BOOTSTRAP_USERNAME'],
                                           'password': admin['FH_BOOTSTRAP_PASSWORD'],
                                           'client': 'web', 'device_label': 'deploy-check'}).encode(),
                          headers={'Content-Type': 'application/json', 'Origin': origin})
        with opener.open(request, timeout=10) as response:
            csrf = json.load(response)['csrf_token']
        cookie = next(c.value for c in jar if c.name == 'fh_s')
    else:
        cookie = private_env(existing)['FH_SMOKE_COOKIE']
    try:
        with connect('wss://' + site + '/api/v1/ws', origin=origin,
                     additional_headers={'Cookie': 'fh_s=' + cookie},
                     open_timeout=10, proxy=None) as ws:
            # A successful connect proves HTTP 101; receive-only, no robot frames.
            assert ws.response.status_code == 101
    finally:
        if owned_session and csrf:
            request = Request(origin + '/api/v1/auth/logout', method='POST',
                              headers={'Origin': origin, 'X-FH-CSRF': csrf})
            with opener.open(request, timeout=10) as response:
                assert response.status == 204


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('HTTPS/HTTP/WS smoke check failed; private details suppressed') from None
