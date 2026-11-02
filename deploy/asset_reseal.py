"""Explicit offline Go2 asset reseal and recoverable config/validation pair switch.

No prepare/bootstrap, downloads, package operations, signals or session starts.
Old seals and transaction evidence are retained. Runtime activation is separate.
"""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile

from . import rootfs_runtime as rt
from .rootfs_config import RootTree

ASSETS = Path('/opt/foothold-sim/assets')
AUDITS = Path('/var/lib/foothold/asset-reseal')
DEPLOY_LOCK = Path('/var/lib/foothold/deploy.lock')
PACKAGE = Path('/var/lib/foothold/sim-packages-unproven')
PINS = Path(__file__).with_name('go2-mesh-pins.json')
MESH_REL = 'source/gz/model/out/meshes/'
MODEL_REL = 'sensor-spec-20261016/stage/sensor-runtime-r1'
MAX_ASSET_BYTES = 512 * 1024**2


def digest(body):
    return hashlib.sha256(body).hexdigest()


def encode(value):
    return rt.shared.canonical(value) + b'\n'


def require_hash(value):
    if not isinstance(value, str) or not rt.shared.HASH.fullmatch(value):
        raise ValueError('exact SHA256 required')
    return value


def private_bytes(path, mode, maximum=32 * 1024**2):
    rt.refresh_directory(path.parent)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0
                or stat.S_IMODE(info.st_mode) != mode or info.st_nlink != 1
                or info.st_size > maximum):
            raise ValueError('untrusted reseal input')
        body = stream.read(maximum + 1)
        after = os.fstat(stream.fileno())
        if len(body) > maximum or (info.st_size, info.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError('reseal input changed')
        return body


def sync_dir(path):
    rt.refresh_sync(path)


def exclusive(path, body, mode=0o400):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(body)
        stream.flush()
        os.fchmod(stream.fileno(), mode)
        os.fsync(stream.fileno())
    sync_dir(path.parent)


def replace_bytes(path, body, mode):
    """Unique owned scratch, including when a previous write failed mid-flight."""
    rt.refresh_directory(path.parent)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '.reseal-', dir=path.parent)
    temporary = Path(temporary)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(body)
            stream.flush()
            os.fchmod(stream.fileno(), mode)
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_dir(path.parent)
    finally:
        if temporary.exists():
            temporary.unlink()  # Only this operation's O_EXCL temporary.


@contextmanager
def locked():
    if os.geteuid() != 0:
        raise PermissionError('server root required')
    fds = []
    try:
        for path in (DEPLOY_LOCK, rt.GUARD / 'deploy.lock'):
            rt.refresh_directory(path.parent)
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            fds.append(fd)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0:
                raise ValueError('untrusted existing admission lock')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        for fd in reversed(fds):
            os.close(fd)


def idle(data, *, retained=False):
    for marker in (PACKAGE, rt.GUARD / 'setup-unproven', rt.GUARD / 'state/unproven'):
        pending = marker.with_name(marker.name + '.release-pending')
        if pending.exists() or pending.is_symlink():
            raise ValueError('release-pending fence retained')
        if marker.exists() or marker.is_symlink():
            if not retained or marker != rt.GUARD / 'state/unproven':
                raise ValueError('existing cleanup fence retained')
            # Restoring bindings after a failed episode never clears its latch.
            fd = os.open(marker, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            with os.fdopen(fd, 'rb') as stream:
                info = os.fstat(stream.fileno())
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != data['identity']['uid']
                        or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 65536):
                    raise ValueError('untrusted episode fence')
    rt.inactive_namespace(data)  # Real UID/unit/cgroup/domain93/partition/DDS proof.


def input_files(directory, expected_sha):
    rt.refresh_directory(directory)
    if stat.S_IMODE(directory.stat().st_mode) != 0o700:
        raise ValueError('private Go2 input directory must be 0700')
    manifest = private_bytes(directory / 'INPUT.json', 0o600, 65536)
    if digest(manifest) != require_hash(expected_sha):
        raise ValueError('private input manifest SHA differs')
    pins = json.loads(PINS.read_bytes())
    if json.loads(manifest) != pins or set(p.name for p in directory.iterdir()) != set(pins['files']) | {'INPUT.json'}:
        raise ValueError('only the reviewed Go2 meshes and notices are accepted')
    result = {}
    for name, pin in pins['files'].items():
        body = private_bytes(directory / name, 0o600, pin['size'])
        if len(body) != pin['size'] or digest(body) != pin['sha256']:
            raise ValueError('Go2 input bytes differ from reviewed pin')
        result[name] = body
    return result, pins


def seal(old, files, pins, key):
    """Copy verified ordinary bytes, never modify or link into the old seal."""
    require_hash(key)
    old_source = rt.assets(old)
    rt.refresh_directory(ASSETS)
    parent = ASSETS / key
    if parent.exists() or parent.is_symlink():
        raise ValueError('candidate exists; no automatic reseal retry')
    document = rt.build.private_json(old_source.parent / 'MANIFEST.json', 0o400)
    rows = document['rows']
    total = sum(row.get('size', 0) for row in rows) + sum(map(len, files.values()))
    if total > MAX_ASSET_BYTES or shutil.disk_usage(ASSETS).free < 256 * 1024**2 + total * 2:
        raise ValueError('asset copy resource envelope exceeded')
    parent.mkdir(mode=0o700)
    old_paths = {row['path'] for row in rows}
    additions = {MESH_REL + name: body for name, body in files.items()}
    additions['GO2-MESH-PROVENANCE.json'] = encode(dict(schema=1, old_manifest_sha256=old['asset_manifest_sha256'], inputs=pins))
    if old_paths & additions.keys():
        raise ValueError('reseal may only add the declared closure')
    with RootTree(old_source.parent) as source, RootTree(parent) as target:
        for row in rows:
            relative = row['path']
            if row['type'] == 'dir':
                target.mkdir(relative)
            elif row['type'] == 'file':
                body = source.read(relative)
                if len(body) != row['size'] or digest(body) != row['sha256']:
                    raise ValueError('old sealed bytes changed during copy')
                target.write(relative, body)
                (parent / relative).chmod(row['mode'])
            else:
                raise ValueError('sealed asset contains a nonordinary member')
        for relative, body in additions.items():
            target.write(relative, body)
            (parent / relative).chmod(0o444)
    for path in sorted(parent.rglob('*'), key=lambda p: len(p.parts), reverse=True):
        if path.is_dir():
            path.chmod(0o555)
            sync_dir(path)
        else:
            with path.open('rb') as stream:
                os.fsync(stream.fileno())
    actual = rt.shared.tree_manifest(parent)
    # Every original path, byte, mode and owner is retained, not merely its files.
    by_path = {row['path']: row for row in actual}
    if any(by_path.get(row['path']) != row for row in rows):
        raise ValueError('reseal changed an existing asset member')
    body = encode(dict(schema=1, rows=actual))
    exclusive(parent / 'MANIFEST.json', body)
    parent.chmod(0o555)
    sync_dir(ASSETS)
    # Recheck the old seal as well as the complete candidate before any switch.
    rt.assets(old)
    candidate = dict(old, asset_source=str(parent / 'source'), asset_manifest_sha256=digest(body))
    rt.assets(candidate)
    return candidate


def record_path(transaction):
    require_hash(transaction)
    rt.refresh_directory(AUDITS)
    path = AUDITS / transaction
    rt.refresh_directory(path)
    return path


def save(path, record):
    replace_bytes(path / 'STATE.json', encode(record), 0o400)


def documents(path, record):
    if record.get('asset_key') != path.name or set(record.get('hashes', {})) != {
            'old-config', 'old-validation', 'new-config', 'new-validation'}:
        raise ValueError('transaction identity or document set differs')
    result = {}
    for name, mode in (('old-config', 0o600), ('old-validation', 0o400), ('new-config', 0o600), ('new-validation', 0o400)):
        body = private_bytes(path / (name + '.json'), mode)
        if digest(body) != record['hashes'][name]:
            raise ValueError('transaction document SHA differs')
        result[name] = body
    old, new = (json.loads(result[name]) for name in ('old-config', 'new-config'))
    if ({k: v for k, v in old.items() if k not in ('asset_source', 'asset_manifest_sha256')}
            != {k: v for k, v in new.items() if k not in ('asset_source', 'asset_manifest_sha256')}):
        raise ValueError('reseal changed a non-asset runtime field')
    if str(Path(new['asset_source']).parent) != str(ASSETS / record['asset_key']):
        raise ValueError('candidate asset path differs')
    rt.checked_validation(old, json.loads(result['old-validation']))
    rt.checked_validation(new, json.loads(result['new-validation']))
    return result


def restore_pair(path, record, docs):
    # May recover a crash between two atomic replacements, but never overwrite
    # unrelated settings or data belonging to a different transaction.
    current = rt.load()
    rt.assets(dict(json.loads(docs['old-config']), identity=current['identity']))
    for name, target, mode in (('config', rt.CONFIG, 0o600), ('validation', rt.VALIDATION, 0o400)):
        actual = private_bytes(target, mode)
        if actual not in (docs['old-' + name], docs['new-' + name]):
            raise ValueError('runtime pair belongs to another transaction')
    replace_bytes(rt.CONFIG, docs['old-config'], 0o600)
    replace_bytes(rt.VALIDATION, docs['old-validation'], 0o400)
    rt.validated(rt.load())
    record['phase'] = 'restored'
    save(path, record)


def switch(path, record):
    docs = documents(path, record)
    if private_bytes(rt.CONFIG, 0o600) != docs['old-config'] or private_bytes(rt.VALIDATION, 0o400) != docs['old-validation']:
        raise ValueError('runtime pair changed before switch')
    data = rt.load()
    idle(data)
    candidate = dict(json.loads(docs['new-config']), identity=data['identity'])
    rt.assets(candidate)
    rt.mesh_preflight(candidate, rt.CURRENT.resolve(strict=True))
    record['phase'] = 'switch-pending'
    save(path, record)
    try:
        replace_bytes(rt.CONFIG, docs['new-config'], 0o600)
        replace_bytes(rt.VALIDATION, docs['new-validation'], 0o400)
        current = rt.load()
        rt.assets(current)
        rt.validated(current)
        idle(current)
        record['phase'] = 'switched'
        save(path, record)
    except BaseException as error:
        record['switch_error_type'] = type(error).__name__
        restore_pair(path, record, docs)
        raise


def apply(directory, input_sha, config_sha, validation_sha):
    with locked():
        old_config = private_bytes(rt.CONFIG, 0o600)
        old_validation = private_bytes(rt.VALIDATION, 0o400)
        if digest(old_config) != require_hash(config_sha) or digest(old_validation) != require_hash(validation_sha):
            raise ValueError('runtime audit pins changed')
        data = rt.load()
        idle(data)
        rt.validated(data)
        files, pins = input_files(directory, input_sha)
        transaction = rt.build.digest(dict(schema=1, config=config_sha, validation=validation_sha, inputs=input_sha))
        if not AUDITS.exists():
            rt.refresh_directory(AUDITS.parent)
            AUDITS.mkdir(mode=0o700)
        rt.refresh_directory(AUDITS)
        if stat.S_IMODE(AUDITS.stat().st_mode) != 0o700:
            raise ValueError('private transaction directory must be 0700')
        path = AUDITS / transaction
        path.mkdir(mode=0o700)  # O_EXCL transaction; interrupted work is never retried.
        record = dict(schema=1, transaction=transaction, phase='preparing', hashes={}, asset_key=transaction,
                      baseline=dict(config=config_sha, validation=validation_sha, inputs=input_sha,
                                    asset_manifest=data['asset_manifest_sha256']))
        save(path, record)
        try:
            record['operation_stage'] = 'seal'
            save(path, record)
            candidate = seal(data, files, pins, transaction)
            record['operation_stage'] = 'mesh-preflight'
            save(path, record)
            rt.mesh_preflight(candidate, rt.CURRENT.resolve(strict=True))
            record['operation_stage'] = 'native-proof'
            save(path, record)
            proof = rt.probe_evidence(candidate)  # Actual ABI/EGL/root identity, not inherited booleans.
            rt.checked_validation(candidate, proof)
            idle(data)
            if private_bytes(rt.CONFIG, 0o600) != old_config or private_bytes(rt.VALIDATION, 0o400) != old_validation:
                raise ValueError('probe changed the live runtime pair')
            new_config = {k: v for k, v in candidate.items() if k != 'identity'}
            values = {'old-config': old_config, 'old-validation': old_validation,
                      'new-config': encode(new_config), 'new-validation': encode(proof)}
            for name, body in values.items():
                exclusive(path / (name + '.json'), body, 0o600 if name.endswith('config') else 0o400)
            record['hashes'] = {name: digest(body) for name, body in values.items()}
            record['phase'] = 'prepared'
            save(path, record)
            switch(path, record)
        except BaseException as error:
            if record['phase'] not in ('restored', 'switch-pending', 'switched'):
                record['phase'] = 'preparation-failed'
                record['error_type'] = type(error).__name__
                save(path, record)
            raise
        return dict(transaction=transaction, phase=record['phase'], asset_manifest_sha256=candidate['asset_manifest_sha256'], namespace_started=False)


def restore(transaction):
    with locked():
        path = record_path(transaction)
        record = json.loads(private_bytes(path / 'STATE.json', 0o400))
        if record.get('schema') != 1 or record.get('transaction') != transaction or record.get('phase') not in ('switched', 'switch-pending'):
            raise ValueError('transaction is not recoverable')
        data = rt.load()
        idle(data, retained=True)
        # Keep a failed episode's latch exactly as observed throughout rollback.
        marker = rt.GUARD / 'state/unproven'
        before = (marker.lstat().st_dev, marker.lstat().st_ino, marker.read_bytes()) if marker.exists() else None
        docs = documents(path, record)
        restore_pair(path, record, docs)
        after = (marker.lstat().st_dev, marker.lstat().st_ino, marker.read_bytes()) if marker.exists() else None
        if before != after:
            raise ValueError('retained episode fence changed during rollback')
        return dict(transaction=transaction, phase='restored', namespace_started=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='operation', required=True)
    stage = sub.add_parser('apply')
    stage.add_argument('directory', type=Path)
    stage.add_argument('input_sha256')
    stage.add_argument('config_sha256')
    stage.add_argument('validation_sha256')
    rollback = sub.add_parser('restore')
    rollback.add_argument('transaction')
    args = parser.parse_args()
    if args.operation == 'apply':
        result = apply(args.directory, args.input_sha256, args.config_sha256, args.validation_sha256)
    else:
        result = restore(args.transaction)
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('asset reseal failed; private evidence retained, no automatic retry') from None
