"""Offline check never runs as kernel root or without fakeroot wrapping."""
import os
from pathlib import Path
import subprocess
import sys
import pytest
from deploy import rootfs_preflight as preflight


def test_unwrapped_cli_refuses_before_reading_recipe_or_creating_output(tmp_path):
    env=dict(os.environ);env.pop('FAKEROOTKEY',None)
    report=tmp_path/'report.json'
    result=subprocess.run([sys.executable,'-B','-m','deploy.rootfs_preflight',
        str(tmp_path/'absent.json'),'a'*64,'--debs',str(tmp_path/'debs'),
        '--wheels',str(tmp_path/'wheels'),'--work-parent',str(tmp_path),'--report',str(report)],
        env=env,capture_output=True,text=True)
    assert result.returncode!=0 and 'unprivileged user under existing fakeroot' in result.stderr
    assert not report.exists() and not list(tmp_path.iterdir())


def test_kernel_root_refuses_even_when_fakeroot_environment_is_present(tmp_path,monkeypatch):
    monkeypatch.setattr(preflight,'kernel_uid',lambda:0)
    monkeypatch.setattr(preflight.os,'geteuid',lambda:0)
    monkeypatch.setenv('FAKEROOTKEY','fixture')
    with pytest.raises(ValueError,match='unprivileged'):
        preflight.check(tmp_path/'absent','a'*64,tmp_path,tmp_path,tmp_path,tmp_path/'report')
    assert not list(tmp_path.iterdir())
