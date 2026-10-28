"""Metadata-only full-rootfs planner. No update/download/extract/install/run API."""
import sys
sys.dont_write_bytecode = True
import hashlib
import argparse
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile

from . import sim_sysroot as shared

# Complete userland dependency roots; none are taken from the host inventory.
BASE_ROOTS = ('base-files','base-passwd','bash','dash','coreutils','debianutils',
    'findutils','grep','sed','gawk','tar','gzip','xz-utils','util-linux','mount',
    'passwd','login','procps','iproute2','ca-certificates','systemd','dbus-user-session',
    'dbus-bin','libegl-mesa0','libgl1-mesa-dri')
SNAPSHOT = '2026-09-11'
PREFIX = Path('/opt/foothold-sim/rootfs-plans')


def apt_config(plan, cache):
    """A separate configuration, empty status and no host hooks or pkgcache."""
    for leaf in ('etc/parts','etc/sourceparts','etc/trustedparts','state','cache/archives/partial',
                 'logs','tmp','home/gnupg'):
        (plan/leaf).mkdir(parents=True,exist_ok=True,mode=0o700)
    (plan/'state/status').write_bytes(b'')
    (plan/'etc/main.conf').write_text('')
    ubuntu=cache/'keyrings/ubuntu.gpg';ros=cache/'keyrings/ros.gpg'
    sources=(f'deb [arch=amd64 signed-by={ubuntu}] http://archive.ubuntu.com/ubuntu noble main universe\n'
        f'deb [arch=amd64 signed-by={ubuntu}] http://archive.ubuntu.com/ubuntu noble-updates main universe\n'
        f'deb [arch=amd64 signed-by={ubuntu}] http://security.ubuntu.com/ubuntu noble-security main universe\n'
        f'deb [arch=amd64 signed-by={ros}] http://snapshots.ros.org/jazzy/{SNAPSHOT}/ubuntu noble main\n')
    (plan/'etc/sources.list').write_text(sources)
    config=f'''Dir "{plan}";
Dir::Etc "etc";
Dir::Etc::main "main.conf";
Dir::Etc::parts "parts";
Dir::Etc::sourcelist "sources.list";
Dir::Etc::sourceparts "sourceparts";
Dir::Etc::trusted "trusted.gpg";
Dir::Etc::trustedparts "trustedparts";
Dir::State "state";
Dir::State::status "{plan}/state/status";
Dir::State::lists "{cache}/lists";
Dir::State::extended_states "{plan}/state/extended_states";
Dir::Cache "{plan}/cache";
Dir::Cache::pkgcache "";
Dir::Cache::srcpkgcache "";
Dir::Log "{plan}/logs";
APT::Architecture "amd64";
APT::Architectures {{ "amd64"; }};
APT::Install-Recommends "false";
APT::Install-Suggests "false";
APT::Get::Simulate "true";
APT::Get::AllowUnauthenticated "false";
APT::Sandbox::User "root";
Acquire::Languages "none";
Acquire::AllowInsecureRepositories "false";
Acquire::AllowDowngradeToInsecureRepositories "false";
Acquire::https::Verify-Peer "true";
Acquire::https::Verify-Host "true";
'''
    (plan/'apt.conf').write_text(config)
    return plan/'apt.conf'


def changes(text):
    rows=[];seen=set()
    for line in text.splitlines():
        if line.startswith(('Remv ','Purg ')):
            raise ValueError('empty rootfs cannot remove a package')
        if not line.startswith('Inst '):continue
        match=re.fullmatch(r'Inst (\S+) \((\S+)(?: .*)?\)',line)
        if not match:raise ValueError('unexpected installed-state simulation; host mixing refused')
        name,version=match.groups();name=name.removesuffix(':amd64')
        if (not shared.NAME.fullmatch(name) or not shared.VERSION.fullmatch(version)
                or shared.DRIVER_FORBIDDEN.search(name) or name in seen):
            raise ValueError('invalid/driver/duplicate rootfs package')
        seen.add(name);rows.append((name,version))
    if not rows:raise ValueError('empty dependency closure')
    return rows


def package_rows(text, selected):
    records={}
    for block in text.strip().split('\n\n'):
        fields=dict(line.split(': ',1) for line in block.splitlines() if ': ' in line and not line.startswith(' '))
        key=(fields.get('Package'),fields.get('Version'))
        records.setdefault(key,[]).append(fields)
    result=[]
    for name,version in selected:
        rows=[]
        for fields in records.get((name,version),[]):
            if fields.get('Architecture') not in ('amd64','all'):continue
            checksum=fields.get('SHA256','');filename=fields.get('Filename','')
            if (not shared.HASH.fullmatch(checksum) or not filename.startswith('pool/')
                    or any(part in ('','.','..') for part in filename.split('/'))):
                raise ValueError('signed package metadata incomplete/unsafe')
            size=int(fields['Size']);installed=int(fields['Installed-Size'])*1024
            if size<=0 or installed<0:raise ValueError('invalid signed sizes')
            rows.append(dict(name=name,version=version,sha256=checksum,filename=filename,
                             download_bytes=size,installed_bytes=installed))
        unique={shared.canonical(row) for row in rows}
        if len(unique)!=1:raise ValueError('signed exact package unavailable/ambiguous')
        result.append(rows[0])
    return result


def verify_cached_packages(release, cache, prefix, components, now=None):
    """Bind uncompressed cached Packages bytes to the authenticated Release."""
    now=datetime.now(timezone.utc) if now is None else now
    text=release.read_text();fields={};checks={};in_sha=False
    for line in text.splitlines():
        if line=='SHA256:':in_sha=True;continue
        if in_sha and line.startswith(' '):
            digest,size,name=line.split()
            if not shared.HASH.fullmatch(digest):raise ValueError('invalid Release digest')
            value=(digest,int(size))
            if name in checks and checks[name]!=value:raise ValueError('ambiguous signed index identity')
            checks[name]=value;continue
        in_sha=False
        if line.startswith(('Date:','Valid-Until:')):
            key,value=line.split(':',1);parsed=parsedate_to_datetime(value.strip())
            if parsed.tzinfo is None:raise ValueError('Release date lacks timezone')
            fields[key]=parsed
    if 'Date' not in fields or fields['Date'].timestamp()>now.timestamp()+600:
        raise ValueError('Release timestamp missing/in future')
    if 'Valid-Until' in fields and fields['Valid-Until']<now:
        raise ValueError('cached Release expired; explicit metadata refresh required')
    for component in components:
        name=component+'/binary-amd64/Packages'
        if name not in checks:raise ValueError('signed uncompressed Package index unavailable')
        digest,size=checks[name]
        if not 0<size<=512*1024*1024:raise ValueError('signed Package index exceeds bound')
        filename=prefix+'_'+component+'_binary-amd64_Packages'
        path=cache/'lists'/filename
        info=path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size!=size or shared.sha(path)!=digest:
            raise ValueError('cached Package index does not match signed Release')
        # Do not let APT prefer a separate unverified compressed representation.
        if list((cache/'lists').glob(filename+'.*')):
            raise ValueError('compressed cached index requires explicit normalized refresh')


def estimate(plan, cache, run=shared.sandbox):
    config=apt_config(plan,cache)
    empty=plan/'state/status'
    assert empty.read_bytes()==b''
    metadata_before=shared.apt_metadata_digest(cache)
    # Recheck retained signed indexes, using per-repository keys only. No update.
    shown=run(['/usr/bin/gpg','--batch','--no-options','--homedir',str(plan/'home/gnupg'),
        '--with-colons','--show-keys',str(cache/'keyrings/ros.gpg')],plan)
    shared.validate_ros_key(shown)
    indexes=(('archive.ubuntu.com_ubuntu_dists_noble','ubuntu.gpg',('main','universe')),
        ('archive.ubuntu.com_ubuntu_dists_noble-updates','ubuntu.gpg',('main','universe')),
        ('security.ubuntu.com_ubuntu_dists_noble-security','ubuntu.gpg',('main','universe')),
        ('snapshots.ros.org_jazzy_'+SNAPSHOT+'_ubuntu_dists_noble','ros.gpg',('main',)))
    for prefix,key,components in indexes:
        release=cache/'lists'/(prefix+'_InRelease')
        run(['/usr/bin/gpgv','--homedir',str(plan/'home/gnupg'),'--keyring',str(cache/'keyrings'/key),str(release)],plan)
        verify_cached_packages(release,cache,prefix,components)
    pins=shared.requirements();concrete={}
    for name in sorted(set(pins)|set(BASE_ROOTS)):
        text=run(['/usr/bin/apt-cache','madison',name],plan,apt_config=config)
        versions=[line.split('|')[1].strip() for line in text.splitlines() if '|' in line]
        versions=[value for value in versions if shared.VERSION.fullmatch(value)]
        value=next((value for value in versions if name not in pins or shared.upstream(value)==pins[name]),None)
        if value is None:raise ValueError('approved rootfs package pin unavailable')
        concrete[name]=value
    # Exactly one simulation; no host status or installed_versions() call.
    output=run(['/usr/bin/apt-get','--simulate','--no-upgrade','--no-remove',
        '--no-install-recommends','install',*[name+'='+value for name,value in concrete.items()]],plan,apt_config=config)
    (plan/'simulation.txt').write_text(output)
    selected=changes(output)
    actual=dict(selected)
    if any(actual.get(name)!=version for name,version in concrete.items()):
        raise ValueError('direct root omitted/changed by solver')
    text=run(['/usr/bin/apt-cache','show',*[name+'='+version for name,version in selected]],plan,apt_config=config)
    rows=sorted(package_rows(text,selected),key=lambda row:row['name'])
    if empty.read_bytes()!=b'' or shared.apt_metadata_digest(cache)!=metadata_before:
        raise ValueError('empty status/signed cache changed during planning')
    return dict(schema='foothold-rootfs-apt-plan/1',runnable=False,status_empty=True,
        status_sha256=hashlib.sha256(b'').hexdigest(),host_inventory_used=False,
        snapshot=SNAPSHOT,metadata_sha256=metadata_before,
        planner_sha256=shared.sha(Path(__file__)),roots=concrete,packages=rows,
        package_count=len(rows),download_bytes=sum(row['download_bytes'] for row in rows),
        installed_bytes=sum(row['installed_bytes'] for row in rows))


def main():
    import fcntl
    os.umask(0o077)
    if os.geteuid()!=0:raise ValueError('server root metadata planner only')
    shared.ensure_no_install_latch()
    with open('/var/lib/foothold/deploy.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        guard=Path('/var/lib/foothold-sim/guard')
        if guard.exists() or guard.is_symlink():
            raise ValueError('this initial planner requires no activated simulation guard')
        cache=shared.ROOT/'apt'
        for path in (cache,cache/'lists',cache/'keyrings',*cache.parents):
            info=path.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:
                raise ValueError('cached metadata parent untrusted')
        for path in (cache/'keyrings/ros.gpg',cache/'keyrings/ubuntu.gpg'):
            info=path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:
                raise ValueError('cached signing key untrusted')
        PREFIX.mkdir(exist_ok=True,mode=0o700)
        info=PREFIX.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o700:
            raise ValueError('rootfs plan directory untrusted')
        plan=Path(tempfile.mkdtemp(prefix='plan-',dir=PREFIX))
        before=shared.snapshot();(plan/'before.json').write_bytes(shared.canonical(before))
        marker=shared.create_install_latch()
        error=None
        try:
            data=estimate(plan,cache)
            checksum=hashlib.sha256(shared.canonical(data)).hexdigest()
            (plan/'apt-plan.json').write_bytes(shared.canonical(data))
            (plan/'apt-plan.sha256').write_text(checksum+'\n')
        except Exception as caught:
            error=caught
            details=dict(type=type(caught).__name__,message=str(caught))
            for key in ('cmd','returncode','stdout','stderr'):
                value=getattr(caught,key,None)
                if value is not None:details[key]=value[:65536] if isinstance(value,str) else value
            (plan/'error.json').write_text(json.dumps(details))
        # Record after-evidence before comparison, including rejected solves.
        after=shared.snapshot();(plan/'after.json').write_bytes(shared.canonical(after))
        shared.verify_host_unchanged(before,after)
        if error is not None:raise error  # A safe host audit never clears a failed solve.
        shared.clear_install_latch(marker)
        print('Rootfs metadata-only plan='+checksum+' packages='+str(data['package_count'])+
              ' download_bytes='+str(data['download_bytes'])+' installed_bytes='+str(data['installed_bytes'])+
              ' free_bytes='+str(shutil.disk_usage(PREFIX).free)+' runnable=false')


if __name__=='__main__':
    try:
        argparse.ArgumentParser(description=__doc__).parse_args()
        main()
    except Exception as error:
        raise SystemExit('Rootfs planner refused ('+type(error).__name__+'); retain evidence/latch, no automatic retry') from None
