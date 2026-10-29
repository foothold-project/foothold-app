"""Offline metadata fixtures only; no apt execution, host inventory or installation."""
import hashlib
from pathlib import Path
from unittest.mock import patch

import pytest
from deploy import rootfs_plan as plan


def metadata(name,version='1.0-1',size='10',installed='2',checksum='a'*64):
    return '\n'.join(('Package: '+name,'Version: '+version,'Architecture: amd64',
        'Filename: pool/main/f/'+name+'.deb','Size: '+size,'Installed-Size: '+installed,'SHA256: '+checksum))


def test_base_runtime_is_inside_new_rootfs_and_driver_removal_or_host_state_is_refused():
    assert plan.changes('Inst libc6 (2.39-1 Fixture [amd64])\nInst systemd (255.4-1 Fixture [amd64])')==[('libc6','2.39-1'),('systemd','255.4-1')]
    for text in ('Inst libc6 [2.38-1] (2.39-1 Fixture)','Remv existing [1.0]','Purg existing [1.0]',
                 'Inst nvidia-utils (580.1-1 Fixture)','Inst rpcbind (1.0-1 Fixture)',
                 'Inst linux-image-generic (1.0-1 Fixture)',''):
        with pytest.raises(ValueError):plan.changes(text)


def test_signed_sizes_and_identity_are_required():
    rows=plan.package_rows(metadata('libc6'),[('libc6','1.0-1')])
    assert rows[0]['download_bytes']==10 and rows[0]['installed_bytes']==2048
    assert plan.package_rows(metadata('libc6')+'\n\n'+metadata('libc6'),[('libc6','1.0-1')])==rows
    for text in (metadata('libc6',checksum='bad'),metadata('libc6',installed='-1'),
                 metadata('libc6').replace('pool/main/','pool/../'),
                 metadata('libc6')+'\n\n'+metadata('libc6',size='20')):
        with pytest.raises(ValueError):plan.package_rows(text,[('libc6','1.0-1')])


def test_real_empty_status_simulation_accepts_only_empty_suffix():
    fixture=Path(__file__).parent/'fixtures/rootfs-empty-status-inst.txt'
    text=fixture.read_text()
    expected=[('libc6','2.39-0ubuntu8.9'),('libheif-plugin-aomdec','1.17.6-1ubuntu4.9'),
        ('ruby3.2','3.2.3-1ubuntu0.24.04.8'),('ruby-rubygems','3.4.20-1'),
        ('ruby','1:3.2~ubuntu1'),('rake','13.0.6-3'),('ruby-net-telnet','0.2.0-1'),
        ('ruby-webrick','1.8.1-1ubuntu0.2'),('ruby-xmlrpc','0.3.2-2'),
        ('ruby-sdbm','1.0.0-5build4'),('libruby3.2','3.2.3-1ubuntu0.24.04.8')]
    assert plan.changes(text)==expected
    # Conf is normal simulation output; it never becomes an extra selected row.
    assert plan.changes(text+'Conf libc6 (2.39-0ubuntu8.9 Ubuntu:24.04/noble-updates [amd64])\n')==expected
    line=text.splitlines()[0]
    for rejected in (line.replace(' []',' [libc6:amd64]'),line.replace(' []',' [ ]'),
                     line.replace(' []',' [] []'),line.replace(' []',' [] trailing'),
                     line.replace(' (',' [2.39-0ubuntu8.8] (',1),
                     'Remv libc6 [2.39-0ubuntu8.9]','Purg libc6 [2.39-0ubuntu8.9]'):
        with pytest.raises(ValueError):plan.changes(rejected)


def test_new_config_empty_status_and_cached_signed_lists_only(tmp_path):
    root=tmp_path/'plan';cache=tmp_path/'cache'
    config=plan.apt_config(root,cache).read_text()
    assert (root/'state/status').read_bytes()==b''
    assert str(root/'state/status') in config and '/var/lib/dpkg/status' not in config
    assert str(cache/'lists') in config and 'Dir::Cache::pkgcache "";' in config
    assert 'APT::Get::Simulate "true";' in config and 'AllowUnauthenticated "false";' in config
    sources=(root/'etc/sources.list').read_text()
    assert 'signed-by='+str(cache/'keyrings/ros.gpg') in sources and 'snapshots.ros.org/jazzy/2026-09-11' in sources
    assert 'packages.ros.org' not in sources
    assert not list((root/'etc/parts').iterdir())


def test_complete_estimate_never_reads_host_inventory_or_downloads(tmp_path):
    root=tmp_path/'plan';cache=tmp_path/'cache';calls=[]
    names=('base-files','libc6','systemd','ros-jazzy-fixture')
    def run(args,writable,**options):
        calls.append(args)
        assert writable==root
        if args[0]=='/usr/bin/gpg':return 'pub:::::::::\nfpr:::::::::'+plan.shared.ROS_KEY_FINGERPRINT+':\n'
        if args[0]=='/usr/bin/gpgv':
            Path(args[args.index('--output')+1]).write_text('authenticated fixture cleartext\n')
            return ''
        assert options['apt_config']==root/'apt.conf'
        assert (root/'state/status').read_bytes()==b''
        if args[0]=='/usr/bin/apt-cache' and args[1]=='madison':return args[-1]+' | 1.0-1 | signed-fixture\n'
        if args[0]=='/usr/bin/apt-get':
            assert '--simulate' in args and '--no-remove' in args
            assert set(args[args.index('install')+1:])=={name+'=1.0-1' for name in names}
            return '\n'.join('Inst '+name+' (1.0-1 Fixture [amd64])' for name in names)
        assert args[:2]==['/usr/bin/apt-cache','show']
        return '\n\n'.join(metadata(name) for name in names)
    with patch.object(plan,'BASE_ROOTS',names[:-1]), \
            patch.object(plan.shared,'requirements',return_value={names[-1]:'1.0'}), \
            patch.object(plan.shared,'apt_metadata_digest',return_value='b'*64), \
            patch.object(plan,'verify_cached_packages'), \
            patch.object(plan,'cleartext_envelope'), \
            patch.object(plan.shared,'installed_versions',side_effect=AssertionError('host inventory forbidden')):
        result=plan.estimate(root,cache,run)
    assert result['host_inventory_used'] is False and result['status_empty'] is True and result['runnable'] is False
    assert result['status_sha256']==hashlib.sha256(b'').hexdigest()
    assert result['package_count']==4 and result['download_bytes']==40 and result['installed_bytes']==8192
    assert sum(args[0]=='/usr/bin/apt-get' for args in calls)==1
    assert not any(verb in args for args in calls for verb in ('update','download','dpkg-deb'))
    verified=[args for args in calls if args[0]=='/usr/bin/gpgv']
    assert len(verified)==4 and str(cache/'keyrings/ros.gpg') in verified[-1]
    assert all(str(cache/'keyrings/ubuntu.gpg') in args for args in verified[:-1])


def test_cached_packages_are_bound_to_signed_release_and_expiry(tmp_path):
    from datetime import datetime, timezone
    from email.utils import format_datetime
    cache=tmp_path/'cache';(cache/'lists').mkdir(parents=True)
    payload=b'Package: fixture\n';filename='fixture_main_binary-amd64_Packages'
    (cache/'lists'/filename).write_bytes(payload)
    release=tmp_path/'InRelease';now=datetime(2026,10,28,tzinfo=timezone.utc)
    header='Date: '+format_datetime(now)+'\nValid-Until: Thu, 29 Oct 2026 00:00:00 +0000\nSHA256:\n '
    content=header+hashlib.sha256(payload).hexdigest()+' '+str(len(payload))+' main/binary-amd64/Packages\n'
    release.write_text(content)
    plan.verify_cached_packages(release.read_text(),cache,'fixture',('main',),now)
    (cache/'lists'/filename).write_bytes(b'forged cache bytes')
    with pytest.raises(ValueError):plan.verify_cached_packages(release.read_text(),cache,'fixture',('main',),now)
    (cache/'lists'/filename).write_bytes(payload)
    release.write_text(content.replace('29 Oct','27 Oct'))
    with pytest.raises(ValueError):plan.verify_cached_packages(release.read_text(),cache,'fixture',('main',),now)


def test_signed_expiry_cannot_be_overwritten_outside_signature(tmp_path):
    import shutil
    import subprocess
    from datetime import datetime, timezone
    if not shutil.which('gpg') or not shutil.which('gpgv'):
        pytest.skip('gpg/gpgv required for offline signature-envelope regression')
    fixtures=Path(__file__).parent/'fixtures/snapshot-signing'
    directory=tmp_path/'verify';(directory/'home/gnupg').mkdir(parents=True,mode=0o700)
    keyring=directory/'key.gpg'
    subprocess.run(['gpg','--batch','--no-options','--homedir',str(directory/'home/gnupg'),
        '--dearmor','--output',str(keyring),str(fixtures/'expired-public.asc')],check=True,capture_output=True)
    def run(args,*unused,**options):
        return subprocess.run(args,check=True,capture_output=True,text=True).stdout
    cleartext=plan.verified_release(fixtures/'expired.InRelease',directory,keyring,run)
    assert cleartext.startswith('Origin:') and 'BEGIN PGP' not in cleartext
    now=datetime(2026,10,29,tzinfo=timezone.utc)
    with pytest.raises(ValueError,match='expired'):
        plan.verify_cached_packages(cleartext,tmp_path,'fixture',('main',),now)
    payload=b'Package: forged unsigned index\n'
    trailer=('\nDate: Thu, 29 Oct 2026 00:00:00 +0000\nValid-Until: Thu, 29 Oct 2099 00:00:00 +0000\nSHA256:\n '+
             hashlib.sha256(payload).hexdigest()+' '+str(len(payload))+' universe/binary-amd64/Packages\n').encode()
    attack=tmp_path/'appended.InRelease';attack.write_bytes((fixtures/'expired.InRelease').read_bytes()+trailer)
    raw=subprocess.run(['gpgv','--homedir',str(directory/'home/gnupg'),'--keyring',str(keyring),str(attack)],capture_output=True)
    assert raw.returncode==0  # GPG accepts the signed packet and ignores this trailer.
    with pytest.raises(ValueError,match='trailing'):
        plan.verified_release(attack,directory,keyring,run)
    assert not (directory/(attack.name+'.verified')).exists()
    prefixed=tmp_path/'prefixed.InRelease';prefixed.write_bytes(trailer+(fixtures/'expired.InRelease').read_bytes())
    with pytest.raises(ValueError,match='envelope'):
        plan.verified_release(prefixed,directory,keyring,run)


def test_main_failed_estimate_records_after_evidence_and_retains_latch(tmp_path,monkeypatch):
    import json
    from unittest.mock import Mock
    directory=tmp_path/'plan';directory.mkdir()
    marker=tmp_path/'pending'
    def create():
        marker.write_text('pending\n');info=marker.stat();return info.st_dev,info.st_ino
    clear=Mock(side_effect=lambda identity:marker.unlink())
    snapshot=Mock(return_value={'stable':'host-proof'})
    monkeypatch.setattr(plan,'DEPLOY_LOCK',tmp_path/'deploy.lock')
    monkeypatch.setattr(plan,'GUARD',tmp_path/'absent-guard')
    monkeypatch.setattr(plan.os,'geteuid',lambda:0)
    monkeypatch.setattr(plan.os,'umask',lambda value:0o022)
    monkeypatch.setattr(plan,'prepare_plan',lambda cache:directory)
    monkeypatch.setattr(plan.shared,'ensure_no_install_latch',lambda:None)
    monkeypatch.setattr(plan.shared,'create_install_latch',create)
    monkeypatch.setattr(plan.shared,'clear_install_latch',clear)
    monkeypatch.setattr(plan.shared,'snapshot',snapshot)
    def fail(*args):raise ValueError('synthetic solve failed')
    monkeypatch.setattr(plan,'estimate',fail)
    with pytest.raises(ValueError,match='synthetic solve failed'):plan.main()
    assert marker.read_text()=='pending\n'
    clear.assert_not_called()
    assert snapshot.call_count==2
    assert json.loads((directory/'before.json').read_text())=={'stable':'host-proof'}
    assert json.loads((directory/'after.json').read_text())=={'stable':'host-proof'}
    assert json.loads((directory/'error.json').read_text())['message']=='synthetic solve failed'
