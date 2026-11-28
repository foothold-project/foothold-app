#!/usr/bin/env python3
"""데모 서버 조직 설정을 시안 (u9_8 혼잡 시간 · 중복 점검 기준, u9_6 데모 표시, u8_1 클립 보관 일수) 값으로 PATCH 한다.

팀장 11/28 20:23 지시. DB 를 다시 만들지 않고 API 만 쓴다 (PATCH /api/v1/org/settings, 총괄 계정).
값은 시안 html 에서 그대로 읽는다. 막대 자리 (left · width px) 를 06:00~22:00 = 1400 px 눈금으로 시각으로 바꾼다.

실행 (먼저 --dry-run 으로 보낼 값만 본다):
  FH_SEED_PASSWORD=... python3 tools/seed_org_settings.py --base http://<서버>:8830 --user <총괄 아이디> [--dry-run]
  --proto-dir 기본값: /home/jay/data/foothold-app-final/u9
비밀번호는 환경변수 FH_SEED_PASSWORD 또는 입력 창으로만 받는다 (명령줄 인자로 받지 않음).
"""
import argparse
import getpass
import json
import os
import re
import sys
import urllib.error
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

PROTO_DIR = Path('/home/jay/data/foothold-app-final/u9')
DAYS = {'월': 'mon', '화': 'tue', '수': 'wed', '목': 'thu', '금': 'fri', '토': 'sat', '일': 'sun'}
# 시안 gen.py: hx = (h - 6) / 16 * W, W = 1400 (06:00~22:00)
DAY_START_H, SPAN_H, WIDTH_PX = 6, 16, 1400


def clock(px):
    minutes = round((DAY_START_H + px / WIDTH_PX * SPAN_H) * 60)
    return f'{minutes // 60:02d}:{minutes % 60:02d}'


class Crowd(HTMLParser):
    """요일 칸 (<span>월</span>) 뒤 tl2 안의 <b style="left:..;width:..">이름</b> 을 모은다."""

    def __init__(self):
        super().__init__()
        self.day, self.bar, self.text, self.bands = None, None, None, []

    def handle_starttag(self, tag, attrs):
        style = dict(attrs).get('style') or ''
        if tag == 'b' and self.day:
            m = re.search(r'left:([\d.]+)px;width:([\d.]+)px', style)
            if m:
                self.bar = (float(m[1]), float(m[2]))
                self.text = ''
        elif tag == 'span':
            self.text = ''

    def handle_data(self, data):
        if self.text is not None:
            self.text += data

    def handle_endtag(self, tag):
        text = (self.text or '').strip()
        if tag == 'span' and text in DAYS:
            self.day = DAYS[text]
        elif tag == 'b' and self.bar:
            left, width = self.bar
            self.bands.append({'day': self.day, 'start': clock(left), 'end': clock(left + width), 'label': text})
            self.bar = None
        if tag in ('span', 'b'):
            self.text = None


def from_proto(proto_dir):
    crowd_html = (proto_dir / 'u9_8_crowd.html').read_text(encoding='utf-8')
    display_html = (proto_dir / 'u9_6_display.html').read_text(encoding='utf-8')
    parser = Crowd()
    parser.feed(crowd_html)
    if not parser.bands:
        raise SystemExit('u9_8: 혼잡 시간 막대를 찾지 못했습니다.')
    m = re.search(r'<div class="step"><span>[^<]*</span><b>(\d+) 시간</b>', crowd_html)
    if not m:
        raise SystemExit('u9_8: 중복 점검 기준 칸을 찾지 못했습니다.')
    # u9_6 데모 로봇 표시 칸의 마지막 스위치 (<span class="sw on"> = 켬)
    pane = display_html[display_html.rfind('데모 로봇 표시'):]
    sw = re.search(r'<span class="sw( on)?"', pane)
    if not sw:
        raise SystemExit('u9_6: 데모 표시 스위치를 찾지 못했습니다.')
    # u8_1 기록 목록 아래 글 「클립은 서버에 30 일 보관」
    clips = (proto_dir.parent / 'u8' / 'u8_1_list.html').read_text(encoding='utf-8')
    keep = re.search(r'클립은 서버에 (\d+) 일 보관', clips)
    if not keep:
        raise SystemExit('u8_1: 클립 보관 일수를 찾지 못했습니다.')
    return {'show_demo_label': bool(sw[1]), 'busy_hours': parser.bands, 'dup_inspect_min': int(m[1]) * 60,
            'clip_retention_days': int(keep[1])}


def http(base, method, path, body=None, token=None):
    request = urllib.request.Request(base.rstrip('/') + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {})})
    with urllib.request.urlopen(request, timeout=15) as response:
        raw = response.read()
        return response.status, json.loads(raw) if raw else None


def seed(send, username, password, payload):
    """send(method, path, body, token) -> (status, json). 총괄로 로그인해 한 번에 PATCH 한다."""
    status, login = send('POST', '/api/v1/auth/login',
                         {'username': username, 'password': password, 'client': 'app', 'device_label': 'seed_org_settings'}, None)
    if status != 200 or login.get('role') != 'ORG_ADMIN':
        raise SystemExit('총괄 (ORG_ADMIN) 계정으로 로그인해야 합니다.')
    token = login['access_token']
    try:
        status, result = send('PATCH', '/api/v1/org/settings', payload, token)
        if status != 200:
            raise SystemExit(f'PATCH 실패: {status} {result}')
        return {key: result[key] for key in payload}
    finally:
        send('POST', '/api/v1/auth/logout', None, token)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--base', required=True, help='서버 주소 (예: http://<서버>:8830)')
    ap.add_argument('--user', required=True, help='총괄 계정 아이디')
    ap.add_argument('--proto-dir', type=Path, default=PROTO_DIR)
    ap.add_argument('--dry-run', action='store_true', help='보낼 값만 출력하고 보내지 않는다')
    args = ap.parse_args(argv)
    payload = from_proto(args.proto_dir)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    if args.dry_run:
        return 0
    password = os.environ.get('FH_SEED_PASSWORD') or getpass.getpass('총괄 비밀번호: ')
    def send(method, path, body, token):
        try:
            return http(args.base, method, path, body, token)
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read() or b'null')
    saved = seed(send, args.user, password, payload)
    print('저장됨:', json.dumps(saved, ensure_ascii=False))
    return 0 if saved == payload else 1


if __name__ == '__main__':
    sys.exit(main())
