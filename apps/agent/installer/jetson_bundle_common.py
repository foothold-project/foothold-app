"""Shared offline bundle validation (stdlib only, Python 3.10 compatible)."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tarfile
import sys


def provenance(agent):
    spec = importlib.util.spec_from_file_location('jetson_arm_provenance',
        agent/'foothold_agent/go2_direct/arm_provenance.py')
    module = importlib.util.module_from_spec(spec)
    previous = sys.dont_write_bytecode
    try:
        sys.dont_write_bytecode = True
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    return module


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def unpack(archive, destination):
    destination.mkdir(parents=True)
    with tarfile.open(archive) as source:
        members = source.getmembers()
        if any(m.issym() or m.islnk() or not (m.isfile() or m.isdir())
               or Path(m.name).is_absolute() or '..' in Path(m.name).parts for m in members):
            raise ValueError('unsafe source archive')
        # Members were validated above; no links/devices/traversal. Works on 3.10.
        source.extractall(destination, members=members)
    roots = list(destination.iterdir())
    if len(roots) != 1 or not roots[0].is_dir():
        raise ValueError('unexpected archive layout')
    return roots[0]


def checked_bundle(bundle):
    if bundle.resolve() != bundle or not bundle.is_dir() or (bundle/'INCOMPLETE').exists():
        raise ValueError('real completed bundle required')
    entries = {}
    for line in (bundle/'SHA256SUMS').read_text().splitlines():
        checksum, relative = line.split(maxsplit=1)
        path = bundle/relative
        if (len(checksum) != 64 or any(c not in '0123456789abcdef' for c in checksum)
                or Path(relative).is_absolute() or '..' in Path(relative).parts
                or relative in entries or path.resolve() != path or not path.is_file()
                or digest(path) != checksum):
            raise ValueError('bundle checksum or path mismatch')
        entries[relative] = checksum
    actual = {str(p.relative_to(bundle)) for p in bundle.rglob('*') if p.is_file()}
    if actual != set(entries) | {'SHA256SUMS'} or any(p.is_symlink() for p in bundle.rglob('*')):
        raise ValueError('unlisted or symlinked bundle file')
    agent = bundle/'apps/agent'
    arm = provenance(agent)
    for name, row in arm.SOURCES.items():
        if entries.get('sources/'+name) != row['sha256']:
            raise ValueError('unreviewed DDS source')
    lock = json.loads((agent/'installer/jetson-wheels.lock.json').read_text())
    for row in lock['wheels']:
        if entries.get('wheels/'+row['filename']) != row['sha256']:
            raise ValueError('wheel differs from reviewed PyPI lock')
    if {p.name for p in (bundle/'wheels').iterdir()} != {r['filename'] for r in lock['wheels']}:
        raise ValueError('unexpected wheel input')
    return arm, lock
