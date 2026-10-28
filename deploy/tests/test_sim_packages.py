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
        for output in ('Remv safe [1.0-1]', 'Purg safe [1.0-1]', 'Inst safe [0.9-1] (1.0-1 Ubuntu)', 'Inst extra (1.0-1 Ubuntu)'):
            with self.subTest(output=output), self.assertRaises(ValueError):
                validate_simulation(output, locked)

    def test_new_userspace_gl_allowed_existing_changes_and_new_drivers_forbidden(self):
        for name in ('libegl1','libglx0','libglew-dev','libvulkan-dev','libglvnd0','mesa-vulkan-drivers','libglib2.0-0t64'):
            locked = {name:self.row(name,'1.0-1')}
            self.assertEqual(validate_simulation('Inst '+name+' (1.0-1 Ubuntu)', locked), [name])
            with self.assertRaises(ValueError):
                validate_simulation('Inst '+name+' [1.0-1] (1.0-1 Ubuntu)', locked)
        for name in ('nvidia-utils','libnvidia-compute-580','linux-image-generic','foo-dkms',
                     'xserver-xorg-video-nvidia','firmware-sof-signed','cuda-toolkit','dcgm','rpcbind'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                validate_simulation('Inst '+name+' (1.0-1 Ubuntu)', {name:self.row(name,'1.0-1')})

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


class InstalledVersionRegression(unittest.TestCase):
    def test_no_upgrade_skip_must_not_pass_old_installed_protobuf(self):
        from pathlib import Path
        import json
        import stat
        import tempfile
        from types import SimpleNamespace
        from unittest.mock import patch
        from deploy import install_sim_packages as package
        row = dict(name='python3-protobuf',version='3.21.12-8.2ubuntu0.4',sha256='a'*64)
        with tempfile.TemporaryDirectory() as folder:
            lock = Path(folder) / 'lock.json'
            lock.write_text(json.dumps([row]))
            def command(*args):
                if args[0] == 'dpkg-query':
                    return 'python3-protobuf\t3.20.0-1\tinstalled\n'
                if args[0] == 'apt-get' and '--simulate' in args:
                    return ''  # --no-upgrade silently skips the existing package
                raise AssertionError('no installation/download may run')
            with patch.object(package.os, 'fstat',return_value=SimpleNamespace(st_uid=0,st_mode=stat.S_IFREG|0o600)), \
                    patch.object(package,'validate_lock',return_value={row['name']:row}), \
                    patch.object(package,'metadata_sha',return_value='a'*64), patch.object(package,'run',side_effect=command):
                with self.assertRaises(ValueError):
                    package.install(str(lock),commit=False)

    def test_post_install_uses_actual_dpkg_not_cached_abi(self):
        import hashlib
        import json
        from pathlib import Path
        import stat
        import tempfile
        from types import SimpleNamespace
        from unittest.mock import patch
        from deploy import install_sim_packages as package
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            artifact = root / 'synthetic.deb'
            artifact.write_bytes(b'synthetic archive')
            row = dict(name='python3-protobuf',version='3.21.12-8.2ubuntu0.4',
                       sha256=hashlib.sha256(artifact.read_bytes()).hexdigest())
            lock = root / 'lock.json'
            lock.write_text(json.dumps([row]))
            def command(*args):
                if args[0] == 'apt-get':
                    return 'Inst python3-protobuf (3.21.12-8.2ubuntu0.4 Ubuntu)' if '--simulate' in args else ''
                if args[0] == 'dpkg-deb':
                    return row['name'] if args[-1] == 'Package' else row['version']
                raise AssertionError('unexpected command')
            with patch.object(package.os,'fstat',return_value=SimpleNamespace(st_uid=0,st_mode=stat.S_IFREG|0o600)), \
                    patch.object(package,'validate_lock',return_value={row['name']:row}), \
                    patch.object(package,'metadata_sha',return_value=row['sha256']), \
                    patch.object(package,'installed_versions',side_effect=[{}, {row['name']:('3.20.0-1','installed')}]), \
                    patch.object(package,'run',side_effect=command), patch.object(Path,'glob',return_value=[artifact]), \
                    patch('deploy.verify_gz_abi.verify'):
                with self.assertRaises(ValueError):
                    package.install(str(lock),commit=True)

    def test_complete_closure_requires_installed_and_configured(self):
        from deploy.install_sim_packages import verify_installed
        row = dict(name='safe',version='1.0-1',sha256='a'*64)
        for actual in ({}, {'safe':('0.9-1','installed')}, {'safe':('1.0-1','unpacked')}):
            with self.assertRaises(ValueError):
                verify_installed({'safe':row},actual,require_all=True)
        verify_installed({'safe':row},{'safe':('1.0-1','installed')},require_all=True)


class HostIdentityTests(unittest.TestCase):
    def test_snapshot_reads_only_fixed_host_fields(self):
        from pathlib import Path
        from unittest.mock import patch
        from deploy import install_sim_packages as package
        tail = ['S'] + ['0']*18 + ['12345']
        def command(*args):
            if args[0] == 'nvidia-smi':
                return 'driver-version,NVIDIA L4,synthetic-device-id'
            if args[0] == 'systemctl':
                pid = '719' if args[2] == 'nvidia-dcgm.service' else '42'
                return 'LoadState=loaded\nActiveState=active\nSubState=running\nMainPID='+pid+'\nExecMainStartTimestampMonotonic=100\n'
            raise AssertionError('unexpected host command')
        with patch.object(package,'run',side_effect=command), \
                patch.object(Path,'read_text',return_value='719 (nv-hostengine) '+' '.join(tail)):
            snapshot = package.host_snapshot()
        self.assertEqual(snapshot['dcgm_start_ticks'], '12345')
        self.assertEqual(len(snapshot['services']), 5)
        self.assertEqual(snapshot['services']['nvidia-dcgm.service']['MainPID'],'719')

    def test_driver_or_process_identity_change_refused(self):
        import copy
        from deploy.install_sim_packages import verify_host_unchanged
        before = dict(gpu='driver,device',dcgm_start_ticks='12345', services={'api':{'MainPID':'42'}})
        verify_host_unchanged(before, copy.deepcopy(before))
        for after in (dict(before,gpu='changed'), dict(before,dcgm_start_ticks='999'),
                      dict(before,services={'api':{'MainPID':'43'}})):
            with self.assertRaises(ValueError):
                verify_host_unchanged(before, after)


if __name__ == '__main__':
    unittest.main()
