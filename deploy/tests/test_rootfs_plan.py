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
        if args[0]=='/usr/bin/gpgv':return ''
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
    plan.verify_cached_packages(release,cache,'fixture',('main',),now)
    (cache/'lists'/filename).write_bytes(b'forged cache bytes')
    with pytest.raises(ValueError):plan.verify_cached_packages(release,cache,'fixture',('main',),now)
    (cache/'lists'/filename).write_bytes(payload)
    release.write_text(content.replace('29 Oct','27 Oct'))
    with pytest.raises(ValueError):plan.verify_cached_packages(release,cache,'fixture',('main',),now)
