"""Windows OS boundary. PowerShell is invoked without profiles or shell interpolation."""
import base64
import json
import os
from pathlib import Path
import stat
import subprocess


def powershell(script, *, timeout=15):
    encoded = base64.b64encode(("$ErrorActionPreference='Stop'; " + script).encode('utf-16le')).decode('ascii')
    # Use the OS executable, never a command found in the download/current folder.
    executable = Path(os.environ.get('SystemRoot', r'C:\Windows'))/'System32/WindowsPowerShell/v1.0/powershell.exe'
    return subprocess.run([str(executable), '-NoLogo', '-NoProfile', '-NonInteractive',
                           '-EncodedCommand', encoded], check=True, capture_output=True,
                          encoding='utf-8', timeout=timeout,
                          creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


def literal(value):
    # PowerShell treats all five characters as single-quote delimiters.
    escaped = str(value).translate({ord(char): char*2 for char in "'\u2018\u2019\u201a\u201b"})
    return "'" + escaped + "'"


# One process/snapshot per selection; errors never turn into an empty safe route set.
METADATA = r'''
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$a = @(Get-NetAdapter | ForEach-Object { [pscustomobject]@{
 Name=$_.Name; Index=[int]$_.ifIndex; Guid=$_.InterfaceGuid.ToString();
 Mac=$_.MacAddress; Up=($_.Status -eq 'Up'); Physical=$_.HardwareInterface;
 Virtual=$_.Virtual; Type=[int]$_.ifType } })
$i = @(Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceIndex,IPAddress,PrefixLength,AddressState)
$r = @(Get-NetRoute | Where-Object { $_.DestinationPrefix -in @('0.0.0.0/0','::/0') } | Select-Object InterfaceIndex)
$n = @(Get-NetNeighbor -AddressFamily IPv4 | Select-Object IPAddress)
[pscustomobject]@{ adapters=$a; addresses=$i; defaults=$r; neighbors=$n } | ConvertTo-Json -Depth 5 -Compress
'''


def metadata():
    result = powershell(METADATA)
    if len(result.stdout) > 262144:
        raise ValueError('network metadata exceeds limit')
    value = json.loads(result.stdout.lstrip('\ufeff'))
    if not isinstance(value, dict) or any(not isinstance(value.get(k), list) for k in
                                         ('adapters', 'addresses', 'defaults', 'neighbors')):
        raise ValueError('invalid Windows network metadata')
    return value


def no_reparse(path):
    """Reject junction/symlink redirection, including every existing ancestor."""
    path = Path(path)
    if not path.is_absolute():
        raise PermissionError('absolute private path required')
    for item in (path, *path.parents):
        try:
            info = item.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise PermissionError('private path cannot contain reparse points')


def private_acl(path, *, create=False):
    """Protected owner-only DACL; reject broad ACLs instead of repairing saved keys."""
    no_reparse(path)
    kind = 'DirectorySecurity' if Path(path).is_dir() else 'FileSecurity'
    script = '$p=' + literal(path) + '; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; '
    if create:
        script += (f'$a=[Security.AccessControl.{kind}]::new(); $a.SetOwner($sid); '
                   '$a.SetAccessRuleProtection($true,$false); '
                   '$r=[Security.AccessControl.FileSystemAccessRule]::new($sid,"FullControl","Allow"); '
                   '$a.AddAccessRule($r); Set-Acl -LiteralPath $p -AclObject $a; ')
    script += r'''
$a=Get-Acl -LiteralPath $p
if (!$a.AreAccessRulesProtected -or $a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'private owner/protection required' }
$r=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
if ($r.Count -ne 1 -or $r[0].IdentityReference.Value -ne $sid.Value -or $r[0].AccessControlType -ne 'Allow' -or $r[0].IsInherited -or [int]$r[0].FileSystemRights -ne [int][Security.AccessControl.FileSystemRights]::FullControl) { throw 'owner-only ACL required' }
'''
    powershell(script)


def private_directory(path):
    path = Path(path)
    no_reparse(path)
    if not path.exists():
        # This directory contains no secrets until its ACL has been installed.
        path.mkdir(parents=True)
        private_acl(path, create=True)
    else:
        private_acl(path)


def load_credentials(path):
    from .storage import Credentials
    path = Path(path)
    private_directory(path.parent)
    no_reparse(path)
    if not path.exists():
        return None
    private_acl(path)
    with path.open('rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 8192:
            raise PermissionError('private single-link regular credential file required')
        return Credentials(**json.loads(stream.read(8193)))


def save_credentials(credentials, path):
    from dataclasses import asdict
    import secrets
    path = Path(path)
    private_directory(path.parent)
    no_reparse(path)
    if path.exists():
        private_acl(path)
        if path.stat().st_nlink != 1 or not path.is_file():
            raise PermissionError('private single-link regular credential file required')
    temporary = path.parent/('.agent-'+secrets.token_hex(16))
    try:
        # Create empty, then protect before placing any token bytes in the file.
        with temporary.open('xb') as stream:
            private_acl(temporary, create=True)
            stream.write(json.dumps(asdict(credentials)).encode('utf-8'))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        private_acl(path)
    finally:
        temporary.unlink(missing_ok=True)
