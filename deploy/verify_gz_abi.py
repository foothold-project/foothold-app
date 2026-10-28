"""Inspect exact DEB members without extracting paths or loading GPU libraries."""
import io
from pathlib import PurePosixPath
import re
import subprocess
import tarfile

EXPECTED = {
    'ros-jazzy-gz-sim-vendor': ('gz-sim8', '8.15.0'),
    'ros-jazzy-gz-transport-vendor': ('gz-transport13', '13.6.0'),
    'ros-jazzy-gz-msgs-vendor': ('gz-msgs10', '10.4.0'),
    'ros-jazzy-gz-rendering-vendor': ('gz-rendering8', '8.2.3'),
    'ros-jazzy-gz-sensors-vendor': ('gz-sensors8', '8.2.2'),
}


def archive_version(data, stem):
    versions = set()
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        for member in archive:
            name = PurePosixPath(member.name).name
            if name not in (stem + '.pc', stem + '-config-version.cmake'):
                continue
            if not member.isfile() or member.size > 65536:
                raise ValueError('invalid vendor version member')
            text = archive.extractfile(member).read().decode()
            if name.endswith('.pc'):
                versions.update(re.findall(r'^Version:\s*([0-9.]+)\s*$', text, re.M))
            else:
                versions.update(re.findall(r'set\(PACKAGE_VERSION\s+"?([0-9.]+)"?\)', text, re.I))
    if len(versions) != 1:
        raise ValueError('vendor upstream version unproven')
    return versions.pop()


def verify(artifacts):
    for name, (stem, expected) in EXPECTED.items():
        path = artifacts[name]
        data = subprocess.run(['dpkg-deb', '--fsys-tarfile', str(path)],
            check=True, capture_output=True).stdout
        if archive_version(data, stem) != expected:
            raise ValueError('Gazebo upstream ABI differs from approved plan')
