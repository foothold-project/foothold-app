"""Windows desktop integration; no robot SDK imports or network probes."""
import base64
from ipaddress import IPv4Interface
import os
from pathlib import Path
import re
import sys
import socket

from foothold_agent.setup.discovery import NIC, ROBOT_NETWORK
from foothold_agent.setup.windows import metadata, powershell, literal


def canonical_name(index):
    return socket.if_indextoname(index)


def eligible(data, *, configured):
    defaults = {r['InterfaceIndex'] for r in data['defaults']}
    result = []
    for row in data['adapters']:
        name, index = row.get('Name'), row.get('Index')
        # FriendlyName is the name Cyclone DDS 0.10.2's Windows ifaddrs uses.
        if (not isinstance(name, str) or not re.fullmatch(r'''[^<>&"'\u2018-\u201b\x00-\x1f]{1,256}''', name)
                or type(index) is not int or index in defaults or row.get('Up') is not True
                or row.get('Physical') is not True or row.get('Virtual') is not False or row.get('Type') != 6
                or not re.fullmatch(r'[0-9a-fA-F-]{36}', row.get('Guid', ''))):
            continue
        mac = row.get('Mac', '').replace('-', ':').lower()
        if not re.fullmatch(r'(?:[0-9a-f]{2}:){5}[0-9a-f]{2}', mac):
            continue
        if configured and any(str(a.get('AddressState')) not in ('Preferred','4') for a in data['addresses'] if a['InterfaceIndex'] == index):
            continue
        addresses = tuple(sorted((a['IPAddress'], a['PrefixLength']) for a in data['addresses']
                                 if a['InterfaceIndex'] == index))
        def allowed(address, prefix):
            parsed = IPv4Interface(f'{address}/{prefix}')
            return ((parsed.network == ROBOT_NETWORK and address not in ('192.168.123.161','192.168.123.18'))
                    or not configured and parsed.ip.is_link_local)
        if (configured and not addresses) or any(not allowed(a, p) for a, p in addresses):
            continue
        canonical = canonical_name(index)
        if not isinstance(canonical,str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,256}',canonical):
            continue
        result.append((NIC(canonical, index, mac, addresses, name), row['Guid']))
    return result


def candidates(*, query_fn=metadata):
    return [nic for nic, _ in eligible(query_fn(), configured=True)]


def available(*, query_fn=metadata):
    return [dict(name=nic.name, mac=nic.mac, label=nic.dds_name) for nic, _ in eligible(query_fn(), configured=False)]


def configure(name, *, query_fn=metadata, run=powershell):
    data = query_fn()
    found = [(nic, guid) for nic, guid in eligible(data, configured=False) if nic.name == name]
    if len(found) != 1:
        raise PermissionError('wired connection is no longer eligible')
    nic, guid = found[0]
    used = {a['IPAddress'] for a in data['addresses']+data['neighbors']}
    address = next((f'192.168.123.{i}' for i in range(200,255) if f'192.168.123.{i}' not in used), None)
    if address is None:
        raise PermissionError('no available laptop address')
    # Recheck GUID, physical type, addresses and BOTH default route families in
    # the elevated child AFTER the UAC prompt. Index/name reuse cannot retarget it.
    script = ("$ErrorActionPreference='Stop'; $index="+str(nic.index)+'; $guid='+literal(guid)+
              '; $name='+literal(nic.dds_name)+'; $mac='+literal(nic.mac.replace(':','-'))+'; '+r'''
$a=Get-NetAdapter -InterfaceIndex $index
if ($a.InterfaceGuid.ToString() -ne $guid -or $a.Name -ne $name -or $a.MacAddress -ne $mac -or !$a.HardwareInterface -or $a.Virtual -or [int]$a.ifType -ne 6 -or $a.Status -ne 'Up') { throw 'adapter changed' }
if (@(Get-NetRoute -InterfaceIndex $index | Where-Object { $_.DestinationPrefix -in @('0.0.0.0/0','::/0') }).Count) { throw 'default adapter forbidden' }
foreach ($ip in @(Get-NetIPAddress -InterfaceIndex $index -AddressFamily IPv4)) {
 if (!(($ip.IPAddress -like '192.168.123.*' -and $ip.PrefixLength -eq 24 -and $ip.IPAddress -notin @('192.168.123.161','192.168.123.18')) -or $ip.IPAddress -like '169.254.*')) { throw 'shared adapter forbidden' }
}
'''+ '$address='+literal(address)+r'''
if (@(Get-NetIPAddress -AddressFamily IPv4 | Where-Object IPAddress -eq $address).Count -or @(Get-NetNeighbor -AddressFamily IPv4 | Where-Object IPAddress -eq $address).Count) { throw 'address already known' }
& "$env:SystemRoot\System32\netsh.exe" interface ipv4 set address "name=$index" source=static "address=$address" mask=255.255.255.0 gateway=none store=persistent
if ($LASTEXITCODE -ne 0) { throw 'netsh address failed' }
& "$env:SystemRoot\System32\netsh.exe" interface ipv4 set dnsservers "name=$index" source=static address=none validate=no
if ($LASTEXITCODE -ne 0) { throw 'netsh DNS failed' }
# Windows performs DAD. A duplicate/tentative address must never start DDS.
Start-Sleep -Seconds 3
$ip=Get-NetIPAddress -InterfaceIndex $index -AddressFamily IPv4 | Where-Object IPAddress -eq $address
if (!$ip -or $ip.AddressState -ne 'Preferred') { throw 'address not preferred' }
''')
    encoded = base64.b64encode(script.encode('utf-16le')).decode('ascii')
    run("$p=Start-Process -FilePath \"$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" "
        "-Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',"+
        literal(encoded)+"); if ($p.ExitCode -ne 0) { throw 'configuration cancelled or failed' }", timeout=120)
    return address


def startup_path():
    return Path(os.environ['APPDATA'])/'Microsoft/Windows/Start Menu/Programs/Startup/FOOTHOLD 로봇 연결.lnk'


def autostart_enabled():
    return startup_path().is_file()


def set_autostart(enabled, *, run=powershell, executable=None):
    path = startup_path()
    if not enabled:
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    target = Path(executable) if executable else Path(sys.executable).resolve().parent.parent/'FOOTHOLD 로봇 연결.exe'
    if not target.is_file():
        raise FileNotFoundError('installed launcher missing')
    run('$s=(New-Object -ComObject WScript.Shell).CreateShortcut('+literal(path)+'); '
        '$s.TargetPath='+literal(target)+'; $s.Arguments="--autostart"; '
        '$s.WorkingDirectory='+literal(target.parent)+'; $s.Save()')


class InstanceLock:
    """Windows byte-range lock: handle lifetime releases it even after a crash."""
    def __init__(self, path, *, api=None):
        self.path, self.api, self.stream = Path(path), api, None

    def __enter__(self):
        if self.api is None:
            import msvcrt
            self.api = msvcrt
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.stream = self.path.open('a+b')
        try:
            self.stream.seek(0)
            self.api.locking(self.stream.fileno(), self.api.LK_NBLCK, 1)
        except OSError:
            self.stream.close()
            self.stream = None
            raise BlockingIOError('desktop already running') from None
        return self

    def __exit__(self, *args):
        if self.stream is not None:
            try:
                self.stream.seek(0)
                self.api.locking(self.stream.fileno(), self.api.LK_UNLCK, 1)
            finally:
                self.stream.close()
                self.stream = None
