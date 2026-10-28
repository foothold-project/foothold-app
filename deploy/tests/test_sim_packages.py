"""Synthetic locks/apt output/DEB members; never invoke apt or inspect host state."""
import io
import tarfile
import unittest

from deploy.install_sim_packages import validate_lock, validate_simulation
from deploy.verify_gz_abi import archive_version


class PackageGateTests(unittest.TestCase):
    def row(self, name='ros-jazzy-nav2-controller', version='1.3.13-1noble.20260903'):
        return dict(name=name, version=version, sha256='a'*64)

    def test_date_suffix_allowed_upstream_change_refused(self):
        self.assertIn('ros-jazzy-nav2-controller', validate_lock([self.row()], {'ros-jazzy-nav2-controller':'1.3.13'}))
        for row in (self.row(version='1.3.14-1noble'), self.row(version='1.3.13+really1.4.0-1noble'), self.row('libprotobuf32', '3.22.0-1')):
            with self.assertRaises(ValueError):
                validate_lock([row], {})
        with self.assertRaises(ValueError):
            validate_lock([self.row()], {'ros-jazzy-rclpy':'7.1.12'})

    def test_protected_changes_and_unlocked_dependencies_refused(self):
        locked = {'safe':self.row('safe','1.0-1')}
        self.assertEqual(validate_simulation('Inst safe (1.0-1 Ubuntu [amd64])', locked), ['safe'])
        for output in ('Remv safe [1.0-1]', 'Inst safe [0.9-1] (1.0-1 Ubuntu)', 'Inst extra (1.0-1 Ubuntu)'):
            with self.subTest(output=output), self.assertRaises(ValueError):
                validate_simulation(output, locked)

    def test_protected_rule_even_when_package_is_locked(self):
        for name in ('nvidia-utils','libegl1','libgl1','mesa-vulkan-drivers','libgbm1','cuda-toolkit','dcgm','rpcbind'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                validate_simulation('Inst '+name+' (1.0-1 Ubuntu)', {name:self.row(name,'1.0-1')})
        name = 'libglib2.0-0t64'
        self.assertEqual(validate_simulation('Inst '+name+' (1.0-1 Ubuntu)', {name:self.row(name,'1.0-1')}), [name])

    def test_vendor_version_from_deb_member_exact(self):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w') as archive:
            body = b'Name: gz-sim8\nVersion: 8.15.0\n'
            item = tarfile.TarInfo('./opt/ros/jazzy/opt/vendor/lib/pkgconfig/gz-sim8.pc')
            item.size = len(body)
            archive.addfile(item, io.BytesIO(body))
        self.assertEqual(archive_version(output.getvalue(),'gz-sim8'), '8.15.0')
        with self.assertRaises(ValueError):
            archive_version(output.getvalue(),'gz-msgs10')


if __name__ == '__main__':
    unittest.main()
