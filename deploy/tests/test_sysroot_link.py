"""Only synthetic owned directories; never access or create real /opt/ros."""
import os
from pathlib import Path
import tempfile
import unittest

from deploy import sysroot_link as link
from deploy.tests.test_package_transaction import trusted_temporary_owner


class RosLinkTests(unittest.TestCase):
    def test_first_alias_and_atomic_owned_transition(self):
        with tempfile.TemporaryDirectory() as folder,trusted_temporary_owner():
            root=Path(folder);parent=root/'ros';state=root/'record.json'
            one=root/'sysroot/one/opt/ros/jazzy';two=root/'sysroot/two/opt/ros/jazzy'
            before=link.activate(one,'a'*64,parent=parent,state=state)
            self.assertFalse(before['before']['present'])
            self.assertEqual(os.readlink(parent/'jazzy'),str(one))
            link.activate(two,'b'*64,parent=parent,state=state)
            self.assertEqual(os.readlink(parent/'jazzy'),str(two))
            self.assertEqual(sorted(path.name for path in parent.iterdir()),['jazzy'])

    def test_foreign_existing_parent_never_adopted(self):
        with tempfile.TemporaryDirectory() as folder,trusted_temporary_owner():
            root=Path(folder);parent=root/'ros';parent.mkdir()
            with self.assertRaises(FileNotFoundError):
                link.activate(root/'target','a'*64,parent=parent,state=root/'absent-record')
            self.assertFalse((parent/'jazzy').exists())
            self.assertEqual(list(parent.iterdir()),[])

    def test_foreign_entry_or_changed_target_blocks_next_transition(self):
        with tempfile.TemporaryDirectory() as folder,trusted_temporary_owner():
            root=Path(folder);parent=root/'ros';state=root/'record.json';target=root/'target'
            link.activate(target,'a'*64,parent=parent,state=state)
            (parent/'unexpected').touch()
            with self.assertRaises(ValueError):
                link.activate(root/'other','b'*64,parent=parent,state=state)
            self.assertEqual(os.readlink(parent/'jazzy'),str(target))
