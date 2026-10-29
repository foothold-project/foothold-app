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
