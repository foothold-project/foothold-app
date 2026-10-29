"""Synthetic archives only; never inspect host packages or execute payload."""
import hashlib
import io
import tarfile
from contextlib import contextmanager
from pathlib import Path
import os
import pytest
from deploy import rootfs_archive as a


def archive(entries):
    output=io.BytesIO()
    with tarfile.open(fileobj=output,mode='w') as tar:
        for path,kind,value in entries:
            item=tarfile.TarInfo(path);item.mode=0o755 if kind=='dir' else 0o644
            if kind=='file':
                item.size=len(value);tar.addfile(item,io.BytesIO(value));continue
            item.type={'link':tarfile.SYMTYPE,'hardlink':tarfile.LNKTYPE,'dir':tarfile.DIRTYPE,'device':tarfile.CHRTYPE}[kind]
            if kind in ('link','hardlink'):item.linkname=value
            tar.addfile(item)
    return output.getvalue()


def merge(tmp_path,archives):
    packages={key:a.scan(io.BytesIO(data)) for key,data in archives.items()}
    @contextmanager
    def stream(key):yield io.BytesIO(archives[key])
    return a.merge(tmp_path,packages,stream)


def test_usrmerge_absolute_links_and_cross_package_hardlinks_do_not_touch_host(tmp_path):
    sentinel=tmp_path.parent/'sentinel';sentinel.write_bytes(b'HOST')
    one=archive([('bin','dir',None),('bin/sh','link','/usr/bin/bash'),('bin/bash','file',b'rootfs-shell')])
    two=archive([('usr/bin/bash-copy','hardlink','bin/bash'),('usr/bin/alias','link','bash'),('usr/bin/data','file',b'data')])
    expected=merge(tmp_path,{'one':one,'two':two})
    assert (tmp_path/'bin').is_symlink() and os.readlink(tmp_path/'bin')=='usr/bin'
    assert os.readlink(tmp_path/'usr/bin/sh')=='/usr/bin/bash'
    assert (tmp_path/'usr/bin/bash-copy').read_bytes()==b'rootfs-shell'
    assert sentinel.read_bytes()==b'HOST'
    assert expected['usr/bin/bash-copy']['sha256']==hashlib.sha256(b'rootfs-shell').hexdigest()
    assert not (tmp_path/'usr/bin/bash').stat().st_mode&0o222


@pytest.mark.parametrize('entries',[
    [('../escape','file',b'bad')],[('/tmp/escape','file',b'bad')],
    [('device','device',None)],[('x','link','../../escape')],
    [('x','link','/../../escape')],[('x','link','y'),('y','link','x')],
    [('file','file',b'x'),('file/child','file',b'bad')],
    [('x','hardlink','missing')],[('bin','link','/usr/bin')],
])
def test_escapes_cycles_special_nodes_and_unapproved_usrmerge_refuse_before_writes(tmp_path,entries):
    with pytest.raises(ValueError):merge(tmp_path,{'bad':archive(entries)})
    assert list(tmp_path.iterdir())==[]


def test_absolute_and_nested_parent_links_are_canonicalized_inside_root(tmp_path):
    data=archive([('opt/a','link','/usr/lib'),('opt/a/next','link','../share'),
                  ('opt/a/next/fixture','file',b'safe')])
    merge(tmp_path,{'a':data})
    assert (tmp_path/'usr/share/fixture').read_bytes()==b'safe'
    assert os.readlink(tmp_path/'usr/lib/next')=='../share'


def test_collisions_and_duplicate_members_are_not_implicit_replaces(tmp_path):
    one=archive([('usr/lib/fixture','file',b'one')]);two=archive([('lib/fixture','file',b'two')])
    with pytest.raises(ValueError,match='collision'):merge(tmp_path,{'one':one,'two':two})
    assert list(tmp_path.iterdir())==[]
    with pytest.raises(ValueError,match='duplicate'):a.scan(io.BytesIO(archive([('x','file',b'1'),('x','file',b'1')])))


def test_nofollow_directory_fd_rejects_preexisting_symlink(tmp_path):
    (tmp_path/'escape').symlink_to(tmp_path.parent)
    fd=os.open(tmp_path,os.O_RDONLY|os.O_DIRECTORY)
    try:
        with pytest.raises(OSError):a.directory(fd,'escape',create=True)
    finally:os.close(fd)


def test_archive_byte_mutation_between_passes_refuses(tmp_path):
    before=archive([('usr/bin/fixture','file',b'one')]);after=archive([('usr/bin/fixture','file',b'two')])
    @contextmanager
    def stream(key):yield io.BytesIO(after)
    with pytest.raises(ValueError,match='bytes'):
        a.merge(tmp_path,{'fixture':a.scan(io.BytesIO(before))},stream)


def test_capability_xattr_refuses_at_scan_before_any_merge():
    output=io.BytesIO()
    with tarfile.open(fileobj=output,mode='w',format=tarfile.PAX_FORMAT) as tar:
        item=tarfile.TarInfo('usr/bin/privileged');item.mode=0o755;item.size=1
        item.pax_headers={'SCHILY.xattr.security.capability':'fixture-capability'}
        tar.addfile(item,io.BytesIO(b'x'))
    with pytest.raises(ValueError,match='privileged archive metadata'):a.scan(io.BytesIO(output.getvalue()))


@pytest.mark.parametrize('kind',[tarfile.FIFOTYPE,tarfile.CHRTYPE,tarfile.BLKTYPE,b's'])
def test_each_special_node_refuses_at_scan(kind):
    output=io.BytesIO()
    with tarfile.open(fileobj=output,mode='w') as tar:
        item=tarfile.TarInfo('special');item.type=kind;item.mode=0o600;tar.addfile(item)
    with pytest.raises(ValueError,match='special archive node forbidden'):a.scan(io.BytesIO(output.getvalue()))


def test_systemd_literal_hex_escape_round_trips_without_decoding(tmp_path):
    leaf=r'system-systemd\x2dcryptsetup.slice'
    encoded=r'\x2e\x2e\x2fescape'
    data=archive([('usr/lib/systemd/system/'+leaf,'file',b'unit'),
                  ('usr/lib/systemd/system/alias.slice','link',leaf),
                  ('usr/share/'+encoded,'file',b'literal')])
    merge(tmp_path,{'systemd':data})
    assert (tmp_path/'usr/lib/systemd/system'/leaf).read_bytes()==b'unit'
    assert os.readlink(tmp_path/'usr/lib/systemd/system/alias.slice')==leaf
    assert (tmp_path/'usr/share'/encoded).read_bytes()==b'literal'
    assert not (tmp_path/'usr/lib/systemd/system/system-systemd-cryptsetup.slice').exists()
    assert not (tmp_path/'usr/escape').exists()


@pytest.mark.parametrize('path',[r'bad\name',r'bad\x2',r'bad\xGG','bad\nname',
    r'/tmp/\x2descape',r'../\x2descape'])
def test_escape_support_does_not_accept_malformed_or_escaping_members(tmp_path,path):
    with pytest.raises(a.ArchiveError):merge(tmp_path,{'bad':archive([(path,'file',b'x')])})
    assert list(tmp_path.iterdir())==[]


def test_refusal_identifies_package_member_and_link_target_without_raw_controls():
    data=archive([('usr/lib/unit','link','bad\nname')])
    with pytest.raises(a.ArchiveError) as caught:a.scan(io.BytesIO(data),source='fixture (fixture_1_all.deb)')
    error=caught.value
    assert error.source=='fixture (fixture_1_all.deb)' and error.member=='usr/lib/unit'
    assert error.target=='bad\nname'
    assert 'fixture_1_all.deb' in str(error) and 'usr/lib/unit' in str(error) and '\\n' in str(error)
    assert '\n' not in str(error)


def test_graph_canonical_alias_keeps_original_link_provenance():
    data=archive([('./opt/alias','link','/usr/lib'),('./opt/alias/unit','link','../../../../outside')])
    with pytest.raises(a.ArchiveError) as caught:a.graph({'fixture':a.scan(io.BytesIO(data),source='fixture (fixture_1_all.deb)')})
    assert caught.value.source=='fixture (fixture_1_all.deb)'
    assert caught.value.member=='./opt/alias/unit' and caught.value.target=='../../../../outside'


def test_gzip_uncompress_dot_prefixed_hardlink_survives_both_passes(tmp_path):
    # gzip_1.12-1ubuntu3.2_amd64.deb stores this linkname with a leading ./.
    body=b'#!/bin/sh\nexec gzip -d "$@"\n'
    data=archive([('./usr/bin/gunzip','file',body),('./usr/bin/uncompress','hardlink','./usr/bin/gunzip')])
    expected=merge(tmp_path,{'gzip':data})
    assert (tmp_path/'usr/bin/uncompress').read_bytes()==body
    assert expected['usr/bin/uncompress']['sha256']==hashlib.sha256(body).hexdigest()


def test_dot_prefixed_symlink_target_uses_same_normalization_in_both_passes(tmp_path):
    data=archive([('./usr/bin/provider','file',b'safe'),('./usr/bin/alias','link','./provider')])
    merge(tmp_path,{'fixture':data})
    assert (tmp_path/'usr/bin/alias').read_bytes()==b'safe'
    assert os.readlink(tmp_path/'usr/bin/alias')=='provider'


@pytest.mark.parametrize('target',['./other','/usr/bin/provider','../../escape'])
def test_second_pass_hardlink_target_change_is_refused_with_origin(tmp_path,target):
    one=archive([('usr/bin/provider','file',b'safe'),('usr/bin/copy','hardlink','./usr/bin/provider')])
    two=archive([('usr/bin/provider','file',b'safe'),('usr/bin/copy','hardlink',target)])
    rows=a.scan(io.BytesIO(one),source='fixture (fixture_1_all.deb)')
    @contextmanager
    def stream(_):yield io.BytesIO(two)
    with pytest.raises(a.ArchiveError) as caught:a.merge(tmp_path,{'fixture':rows},stream)
    assert caught.value.source=='fixture (fixture_1_all.deb)' and caught.value.member=='usr/bin/copy'
    assert caught.value.target==target
    assert not (tmp_path/'usr/bin/copy').exists()


def test_absolute_hardlink_target_refuses_even_with_matching_internal_file(tmp_path):
    data=archive([('usr/bin/provider','file',b'safe'),
                  ('usr/bin/copy','hardlink','/usr/bin/provider')])
    with pytest.raises(a.ArchiveError,match='escapes root'):merge(tmp_path,{'fixture':data})
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize('before,after',[(0o755,0o644),(0o644,0o755)])
def test_second_pass_execution_bit_only_change_refuses(tmp_path,before,after):
    def with_mode(mode):
        output=io.BytesIO()
        with tarfile.open(fileobj=output,mode='w') as tar:
            item=tarfile.TarInfo('usr/bin/provider');item.mode=mode;item.size=4
            tar.addfile(item,io.BytesIO(b'safe'))
        return output.getvalue()
    rows=a.scan(io.BytesIO(with_mode(before)),source='mode (mode_1_all.deb)')
    @contextmanager
    def stream(_):yield io.BytesIO(with_mode(after))
    with pytest.raises(a.ArchiveError,match='metadata changed') as caught:
        a.merge(tmp_path,{'fixture':rows},stream)
    assert 'mode=' in str(caught.value) and caught.value.member=='usr/bin/provider'
    assert not (tmp_path/'usr/bin/provider').exists()


@pytest.mark.parametrize('after',[
    [('usr/bin/provider','file',b'longer')],
    [('usr/bin/provider','link','/usr/bin/other')],
])
def test_second_pass_size_or_kind_change_refuses_as_metadata_before_writes(tmp_path,after):
    before=archive([('usr/bin/provider','file',b'safe')]);changed=archive(after)
    @contextmanager
    def stream(_):yield io.BytesIO(changed)
    with pytest.raises(a.ArchiveError,match='metadata changed'):
        a.merge(tmp_path,{'fixture':a.scan(io.BytesIO(before))},stream)
    assert not (tmp_path/'usr/bin/provider').exists()
