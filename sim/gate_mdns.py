"""관문 LAN 광고(mDNS/DNS-SD) — 같은 Wi-Fi 의 앱이 «주변 기기»에서 이 관문을 찾게 한다. 계약 D′(UI·모바일 mentor 합의, 2026-10-14).

광고 내용(비밀 0 — 계정·토큰·PID·경로·사용자 이름 없음):
  서비스  _foothold-gate._tcp.local   이름 «FOOTHOLD 관문 · <id8>»   (id8 = 서버 인증서 DER SHA-256 앞 8자 — 인증서 공개값)
  SRV     foothold-gate-<id8>.local : 실제 관문 포트     (시스템 호스트 이름은 사용자 이름을 담고 있어 쓰지 않는다)
  A       인증서 SAN 에 있는 사설 IPv4(10/8·172.16/12·192.168/16)만, 그 주소가 붙은 인터페이스에만
  TXT     txtvers=1 · app=foothold-gate · api=<HEALTH api>   (합 ≤256 B)
광고는 «여기 관문이 있다»는 안내일 뿐 신뢰가 아니다 — 앱은 «미검증»으로 보이고, 신뢰는 TLS·로그인에서 따로 확인한다.
방법: 시스템 avahi-daemon 에 D-Bus(EntryGroup)로 등록. 설정 파일·방화벽·sudo 변경 0. 그룹은 이 프로세스의 D-Bus 연결에 묶여
프로세스가 끝나면(INT·비정상 종료 모두) avahi 가 스스로 거둔다. 실패해도 관문은 계속 돈다(광고만 없음).
"""
import hashlib, ipaddress, json, queue, subprocess, threading, time

TYPE = '_foothold-gate._tcp'
PRIV = [ipaddress.ip_network(n) for n in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')]
IF_UNSPEC, PROTO_INET, NO_REVERSE = -1, 0, 16
STATES = {0: '등록 대기', 1: '등록 중', 2: '광고 중', 3: '이름 충돌', 4: '실패'}


def records(cert_der, port, addrs, sans, api):
    """순수 규칙: (인증서 DER, 포트, [(인터페이스 번호, IPv4)], SAN 문자열, api) → 광고 값. 걸러진 주소가 없으면 addrs 빈 목록"""
    id8 = hashlib.sha256(cert_der).hexdigest()[:8]
    san = {s[3:] for s in sans.split(',') if s.startswith('IP:')}
    keep = []
    for idx, ip in addrs:
        a = ipaddress.ip_address(ip)
        if a.version == 4 and any(a in n for n in PRIV) and ip in san and (idx, ip) not in keep:
            keep.append((idx, ip))
    txt = [f'txtvers=1', 'app=foothold-gate', f'api={int(api)}']
    assert sum(len(t.encode()) + 1 for t in txt) <= 256
    return {'name': f'FOOTHOLD 관문 · {id8}', 'host': f'foothold-gate-{id8}.local', 'port': int(port), 'txt': txt, 'addrs': keep}


def iface_addrs():
    """[(인터페이스 번호, IPv4)] — ip -j 에서 읽기만"""
    out = subprocess.run(['ip', '-j', '-4', 'addr'], capture_output=True, text=True, timeout=5).stdout
    return [(i['ifindex'], x['local']) for i in json.loads(out or '[]') for x in i.get('addr_info', []) if x.get('family') == 'inet']


class Advert:
    """avahi EntryGroup 하나. start() 실패 시 why 에 사유, 관문은 계속"""
    def __init__(self, rec, log):
        self.rec, self.log, self.group, self.state = rec, log, None, None

    def _call(self, path, iface, method, sig, args, ret='()'):
        from gi.repository import GLib, Gio
        return self.bus.call_sync('org.freedesktop.Avahi', path, iface, method, GLib.Variant(sig, args) if sig else None,
                                  GLib.VariantType(ret), Gio.DBusCallFlags.NONE, 3000, None).unpack()

    def start(self):
        r = self.rec
        if not r['addrs']:
            self.log('LAN 광고 안 함 — 인증서 SAN 에 있는 사설 IPv4 가 이 PC 인터페이스에 없음'); return False
        try:
            import gi; gi.require_version('Gio', '2.0')
            from gi.repository import Gio
            self.bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)
            self.group = self._call('/', 'org.freedesktop.Avahi.Server', 'EntryGroupNew', None, (), '(o)')[0]
            G = 'org.freedesktop.Avahi.EntryGroup'
            for idx, ip in r['addrs']:
                self._call(self.group, G, 'AddAddress', '(iiuss)', (idx, PROTO_INET, NO_REVERSE, r['host'], ip))
                self._call(self.group, G, 'AddService', '(iiussssqaay)',
                           (idx, PROTO_INET, 0, r['name'], TYPE, 'local', r['host'], r['port'], [t.encode() for t in r['txt']]))
            self._call(self.group, G, 'Commit', None, ())
        except Exception as e:   # avahi 없음·정책 거부 등 — 관문은 계속
            self.log(f'LAN 광고 실패({type(e).__name__}: {str(e)[:120]}) — 주변 검색에 안 보임, 주소 입력·QR 은 그대로'); self.group = None
            return False
        self.log(f'LAN 광고 등록: {TYPE} «{r["name"]}» 포트 {r["port"]} · 주소 {len(r["addrs"])}개')
        return True

    def poll(self):
        """상태가 바뀔 때만 한 줄. 충돌·실패면 그대로 둔다(이름을 바꿔 재시도하지 않음 — 같은 인증서 관문이 이미 광고 중)"""
        if not self.group: return
        try: s = self._call(self.group, 'org.freedesktop.Avahi.EntryGroup', 'GetState', None, (), '(i)')[0]
        except Exception as e: s = f'조회 실패 {type(e).__name__}'
        if s != self.state:
            self.state = s; self.log(f'LAN 광고 상태: {STATES.get(s, s)}')

    def stop(self):
        if self.group:
            try: self._call(self.group, 'org.freedesktop.Avahi.EntryGroup', 'Free', None, ())
            except Exception: pass   # 연결이 끊기면 avahi 가 어차피 거둔다
            self.group = None


class Runner:
    """광고의 막힐 수 있는 일(ip 조회·D-Bus 등록·상태 조회·해제)을 관문 IOLoop 밖 전용 스레드 하나에서 차례로.
    IOLoop 쪽은 넣기만 한다(막힘 0). 앞 일이 안 끝났으면 새 일은 버린다(동시 1 · 밀림 0). 실패는 광고만 멈추고 관문은 계속.
    daemon 스레드라 걸린 일이 프로세스 종료를 붙잡지 않는다(그때는 D-Bus 연결이 끊기며 avahi 가 거둔다)."""
    def __init__(self, make, log):
        self.make, self.log, self.adv, self.lock, self.busy = make, log, None, threading.Lock(), False
        self.idle, self.q = threading.Event(), queue.SimpleQueue()
        self.idle.set(); threading.Thread(target=self._loop, name='gate-mdns', daemon=True).start()

    def _loop(self):
        while True:
            fn = self.q.get()
            try: fn()
            except Exception as e: self.log(f'LAN 광고 작업 오류({type(e).__name__}) — 광고만 영향, 관문은 계속')
            finally:
                with self.lock: self.busy = False; self.idle.set()

    def submit(self, fn):
        with self.lock:
            if self.busy: return False
            self.busy = True; self.idle.clear()
        self.q.put(fn); return True

    def _start(self):
        self.adv = self.make()
        if not self.adv.start(): self.adv = None

    def begin(self): return self.submit(self._start)
    def tick(self): return self.submit(lambda: self.adv and self.adv.poll())

    def close(self, timeout=4.0):
        """종료 때 해제 — 전체 timeout 초 안에서만 기다린다. 앞 일이 걸려 있으면 해제를 건너뜀"""
        end = time.monotonic() + timeout
        if not self.idle.wait(timeout) or not self.submit(lambda: self.adv and self.adv.stop()):
            self.log('LAN 광고 해제 건너뜀 — 앞 작업이 안 끝남(프로세스 종료 때 avahi 가 거둠)'); return False
        return self.idle.wait(max(0.0, end - time.monotonic()))


def selftest():
    der = b'\x30\x03\x02\x01\x01'; id8 = hashlib.sha256(der).hexdigest()[:8]
    sans = 'DNS:localhost,IP:100.64.0.1,IP:127.0.0.1,IP:192.168.0.10,IP:10.1.2.3,IP:172.20.0.5,IP:172.32.0.1'
    addrs = [(1, '127.0.0.1'), (2, '192.168.0.10'), (3, '100.64.0.1'), (4, '10.1.2.3'), (5, '172.20.0.5'), (6, '172.32.0.1'), (7, '192.168.9.9'), (2, '192.168.0.10')]
    r = records(der, 8453, addrs, sans, 1)
    assert r['addrs'] == [(2, '192.168.0.10'), (4, '10.1.2.3'), (5, '172.20.0.5')], r['addrs']   # 루프백·tailscale·172.32·SAN 밖·중복 0
    assert r['name'] == f'FOOTHOLD 관문 · {id8}' and len(r['name'].encode()) <= 63 and r['host'] == f'foothold-gate-{id8}.local'
    assert r['port'] == 8453 and r['txt'] == ['txtvers=1', 'app=foothold-gate', 'api=1']
    blob = json.dumps(r, ensure_ascii=False)
    for bad in ('hyeon', 'less82', 'token', '/home', 'pid'):
        assert bad not in blob, bad
    assert records(der, 8453, [(1, '127.0.0.1'), (3, '100.64.0.1')], sans, 1)['addrs'] == []   # LAN 없음 → 광고 안 함
    msgs = []; assert Advert(records(der, 1, [], sans, 1), msgs.append).start() is False and '광고 안 함' in msgs[0]
    print('[gate_mdns] selftest OK')


if __name__ == '__main__':
    selftest()
