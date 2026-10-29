"""Private temporary files and fake library metadata only; no host probes."""
from contextlib import contextmanager
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from deploy import install_sim_packages as package


@contextmanager
def trusted_temporary_owner():
    fstat, stat = os.fstat, os.stat
    def root(info):
        return SimpleNamespace(st_uid=0,st_mode=info.st_mode,st_dev=info.st_dev,st_ino=info.st_ino)
    with patch.object(os,'fstat',side_effect=lambda *a,**k:root(fstat(*a,**k))), \
            patch.object(os,'stat',side_effect=lambda *a,**k:root(stat(*a,**k))):
        yield


class PackageTransactionTests(unittest.TestCase):
    def test_failure_retains_latch_and_only_success_can_clear_own_inode(self):
        with tempfile.TemporaryDirectory() as folder, trusted_temporary_owner():
            marker = Path(folder) / 'pending'
            identity = package.create_install_latch(marker)
            with self.assertRaises(ValueError):
                package.verify_host_unchanged({'gpu':'before'},{'gpu':'changed'})
            self.assertTrue(marker.exists())
            with self.assertRaises(ValueError):
                package.ensure_no_install_latch(marker)
            with self.assertRaises(ValueError):
                package.clear_install_latch((identity[0],identity[1]+1),marker)
            self.assertTrue(marker.exists())
            package.clear_install_latch(identity,marker)
            package.ensure_no_install_latch(marker)

    def test_symlink_or_existing_transaction_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as folder, trusted_temporary_owner():
            marker = Path(folder) / 'pending'
            victim = Path(folder) / 'victim'
            victim.write_text('synthetic-sentinel')
            marker.symlink_to(victim)
            with self.assertRaises(FileExistsError):
                package.create_install_latch(marker)
            self.assertEqual(victim.read_text(),'synthetic-sentinel')
            with self.assertRaises(ValueError):
                package.ensure_no_install_latch(marker)

    def test_gl_ownership_known_or_refused_without_package_mutation(self):
        names = ('libEGL_nvidia.so.0','libGLX_nvidia.so.0','libEGL.so.1','libGLX.so.0','libGLdispatch.so.0')
        cache = '\n'.join(name+' (libc6) => /synthetic/'+name for name in names)
        for known in (True,False):
            def command(*args):
                if args == ('ldconfig','-p'):
                    return cache
                if args[:2] == ('dpkg-query','-S'):
                    if known:
                        return 'owned-package:amd64: '+args[-1]
                    raise subprocess.CalledProcessError(1,args)
                raise AssertionError('no package mutation allowed')
            with patch.object(Path,'exists',return_value=False), \
                    patch.object(Path,'resolve',lambda self,**_:self), patch.object(package,'run',side_effect=command):
                if known:
                    self.assertEqual(len(package.verify_gl_owners()),len(names))
                else:
                    with self.assertRaises(ValueError):
                        package.verify_gl_owners()

    def test_run_installer_indicator_refused_before_library_or_apt_probe(self):
        with patch.object(Path,'exists',return_value=True), patch.object(package,'run') as command:
            with self.assertRaises(ValueError):
                package.verify_gl_owners()
            command.assert_not_called()


def test_all_latch_name_mutations_serialize_on_parent_lock(tmp_path):
    import threading
    for operation in ('create','clear'):
        path=tmp_path/operation
        with trusted_temporary_owner():
            identity=package.create_install_latch(path) if operation=='clear' else None
            parent=package.latch_parent(path);started=threading.Event();done=threading.Event();errors=[]
            def mutate():
                started.set()
                try:
                    if operation=='create':package.create_install_latch(path)
                    else:package.clear_install_latch(identity,path)
                except BaseException as error:errors.append(error)
                finally:done.set()
            worker=threading.Thread(target=mutate);worker.start()
            try:
                assert started.wait(1)
                assert not done.wait(.05)
            finally:os.close(parent)
            worker.join(2)
            assert done.is_set() and not errors
