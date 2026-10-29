#!/usr/bin/env python3
"""Read local OS/package/NIC metadata only. Python 3.8+; no SDK import or sockets."""
import argparse
import importlib.metadata
import ipaddress
import json
from pathlib import Path
import platform
import subprocess
import sys

PINNED = {'foothold-agent': '0.2.0', 'websockets': '15.0.1',
          'unitree-sdk2py': '1.0.1', 'cyclonedds': '0.10.2',
          'numpy': '1.26.4', 'opencv-python': '4.10.0.84', 'zeroconf': '0.148.0'}


def evaluate(machine, version, packages, links, dds_override=False):
    issues = []
    if machine != 'aarch64':
        issues.append('not-jetson-aarch64')
    if tuple(version[:2]) < (3, 10):
        issues.append('python-below-3.10')
    for name, pin in PINNED.items():
        if packages.get(name) != pin:
            issues.append('missing-or-different-package:'+name)
    if not any(link['go2_subnet'] and link['up'] for link in links):
        issues.append('no-interface-on-go2-example-subnet')
    if dds_override:
        issues.append('inherited-dds-or-loader-environment')
    return {'ready_for_runtime_review': not issues, 'issues': issues,
            'motion_enabled': False, 'robot_connected': False,
            'sdk_domain_planned': 0, 'dds_runtime_verified': False,
            'sdk_source_commit_verified': False,
            'note': 'Metadata only; cannot verify routing, device identity, DDS or physical motion.'}


def interfaces():
    # ip address show is read-only. Never ping/ARP/scan/discover a robot.
    try:
        value = json.loads(subprocess.run(['ip', '-j', '-4', 'address', 'show'],
            check=True, capture_output=True, text=True, timeout=2).stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        return []
    links = []
    for nic in value:
        subnet = any(ipaddress.ip_address(a['local']) in ipaddress.ip_network('192.168.123.0/24')
                     for a in nic.get('addr_info', []) if a.get('family') == 'inet')
        links.append({'name': nic['ifname'], 'up': 'UP' in nic.get('flags', []),
                      'go2_subnet': subnet})
    return links


def main():
    import os
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    packages = {}
    for name in PINNED:
        try:
            packages[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            packages[name] = None
    links = interfaces()
    override = any(os.environ.get(k) for k in ['CYCLONEDDS_URI','CYCLONEDDS_HOME','LD_LIBRARY_PATH'])
    report = evaluate(platform.machine(), sys.version_info, packages, links, override)
    jetpack = Path('/etc/nv_tegra_release')
    report.update({'machine': platform.machine(), 'python': platform.python_version(),
                   'libc': list(platform.libc_ver()), 'packages': packages, 'interfaces': links,
                   'l4t': jetpack.read_text().splitlines()[0] if jetpack.exists() else None})
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if report['ready_for_runtime_review'] else 2


if __name__ == '__main__':
    sys.exit(main())
