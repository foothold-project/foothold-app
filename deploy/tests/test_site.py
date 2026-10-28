"""Temporary private configurations only; no server files or credentials."""
import json
import os
from pathlib import Path
import shlex
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from deploy import site


def root_stat(stream):
    info=os.stat(stream)
    return SimpleNamespace(st_uid=0,st_gid=info.st_gid,st_mode=info.st_mode,st_ino=info.st_ino,st_dev=info.st_dev,st_mtime_ns=info.st_mtime_ns)


def values(path):return dict(x.split('=',1) for x in shlex.split(path.read_text()))


def test_one_site_sets_api_and_phone_without_losing_private_values(tmp_path):
    root=tmp_path/'etc';root.mkdir();manager=tmp_path/'manager.env'
    for path,text,mode in ((root/'site.env','FH_SITE=sim.example.invalid\n',0o600),
                            (root/'server.env',"SECRET='synthetic value'\nFH_WS_ORIGIN=old\n",0o600),
                            (manager,"PRIVATE='another synthetic'\nFOOTHOLD_PHONE_ORIGINS='[]'\n",0o640)):
        path.write_text(text);path.chmod(mode)
    with patch.object(os,'fstat',side_effect=root_stat),patch.object(os,'fchown') as chown:
        site.update(root,manager)
    assert values(root/'server.env')==dict(SECRET='synthetic value',FH_WS_ORIGIN='https://sim.example.invalid')
    assert values(manager)['PRIVATE']=='another synthetic'
    assert json.loads(values(manager)['FOOTHOLD_PHONE_ORIGINS'])==['https://sim.example.invalid']
    assert manager.stat().st_mode&0o777==0o640 and (root/'server.env').stat().st_mode&0o777==0o600
    assert chown.call_count==2 and not list(tmp_path.rglob('.site-*'))


@pytest.mark.parametrize('bad',['sim.example.invalid:443','https://example.invalid','a..b','example.invalid/path','example.invalid\nINJECT=x'])
def test_unsafe_hostname_leaves_both_envs_unchanged(tmp_path,bad):
    (tmp_path/'site.env').write_text('FH_SITE='+shlex.quote(bad)+'\n');(tmp_path/'site.env').chmod(0o600)
    (tmp_path/'server.env').write_text('KEEP=yes\n')
    with patch.object(os,'fstat',side_effect=root_stat),pytest.raises(ValueError):site.update(tmp_path,tmp_path/'absent')
    assert (tmp_path/'server.env').read_text()=='KEEP=yes\n'


def test_symlink_leaf_and_world_readable_private_file_refused(tmp_path):
    target=tmp_path/'target';target.write_text('SECRET=synthetic\n');target.chmod(0o600)
    link=tmp_path/'link';link.symlink_to(target)
    with pytest.raises(OSError):site.read_private(link)
    target.chmod(0o644)
    with patch.object(os,'fstat',side_effect=root_stat),pytest.raises(ValueError):site.read_private(target)


def test_replaced_private_file_not_overwritten(tmp_path):
    path=tmp_path/'manager.env';path.write_text('KEEP=yes\n');path.chmod(0o600)
    info=root_stat(path);path.unlink();path.write_text('NEW=yes\n')
    with patch.object(os,'fchown'),pytest.raises(ValueError,match='changed'):site.replace_private(path,dict(KEEP='no'),info)
    assert path.read_text()=='NEW=yes\n' and not list(tmp_path.glob('.site-*'))
