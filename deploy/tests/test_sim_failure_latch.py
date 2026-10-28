"""Temporary owned files only. Reproduce and block the root symlink attack."""
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from deploy import mark_sim_failure as latch


class FailureLatchTests(unittest.TestCase):
    def test_runtime_owned_symlink_cannot_truncate_target(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'state').mkdir()
            victim = root / 'victim'
            victim.write_text('synthetic-sentinel')
            (root / 'state/unproven').symlink_to(victim)
            with patch.object(latch.os, 'fstat',return_value=SimpleNamespace(st_uid=0,st_mode=stat.S_IFDIR|0o700)):
                latch.mark(root)
            self.assertEqual(victim.read_text(), 'synthetic-sentinel')
            self.assertEqual((root / 'setup-unproven').read_bytes(), b'activation-failed\n')
            self.assertEqual(stat.S_IMODE((root / 'setup-unproven').stat().st_mode), 0o600)

    def test_root_latch_symlink_or_existing_file_never_overwritten(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            victim = root / 'victim'
            victim.write_text('synthetic-sentinel')
            (root / 'setup-unproven').symlink_to(victim)
            with patch.object(latch.os, 'fstat',return_value=SimpleNamespace(st_uid=0,st_mode=stat.S_IFDIR|0o700)):
                with self.assertRaises(FileExistsError):
                    latch.mark(root)
            self.assertEqual(victim.read_text(), 'synthetic-sentinel')

    def test_untrusted_guard_owner_or_permissions_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            for uid, mode in ((1,0o700),(0,0o777)):
                with patch.object(latch.os, 'fstat',return_value=SimpleNamespace(st_uid=uid,st_mode=stat.S_IFDIR|mode)):
                    with self.assertRaises(ValueError):
                        latch.mark(folder)
            self.assertFalse((Path(folder) / 'setup-unproven').exists())
