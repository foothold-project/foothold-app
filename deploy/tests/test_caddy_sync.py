"""Temporary files and fake Caddy/systemctl only; no server or network."""
import os
from pathlib import Path
import stat
import subprocess
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from deploy import caddy_sync


@pytest.fixture
def transaction(tmp_path):
    config = tmp_path / 'Caddyfile'
    config.write_bytes(b'old\n\x00')
    config.chmod(0o640)
    candidate = tmp_path / 'repository.Caddyfile'
    candidate.write_bytes(b'{$FH_SITE} { respond "new" }\n')
    sync = caddy_sync.Sync(config, tmp_path / 'private')
    fstat, lstat = os.fstat, Path.lstat

    def root_info(info):
        return SimpleNamespace(st_uid=0, st_gid=0, st_mode=info.st_mode,
                               st_ino=info.st_ino, st_mtime_ns=info.st_mtime_ns)

    def fake_command(args, check=False):
        return subprocess.CompletedProcess(args, 0)

    with patch.object(os, 'fstat', side_effect=lambda fd: root_info(fstat(fd))), \
            patch.object(Path, 'lstat', side_effect=lambda p: root_info(lstat(p)), autospec=True), \
            patch.object(os, 'fchown') as chown, \
            patch.object(subprocess, 'run', side_effect=fake_command) as command:
        yield sync, candidate, command, chown


def record(sync, content=None):
    sync.check_state()
    caddy_sync.replace(sync.record, (caddy_sync.digest(
        sync.config.read_bytes() if content is None else content) + '\n').encode())


def test_same_is_noop(transaction):
    sync, candidate, command, _ = transaction
    candidate.write_bytes(sync.config.read_bytes())
    record(sync)
    before = sync.config.stat(), sync.record.stat()
    sync.prepare(candidate)
    sync.commit()
    assert sync.config.stat() == before[0] and sync.record.stat() == before[1]
    assert not sync.backup.exists() and not sync.pending.exists()
    command.assert_not_called()


def test_tracked_replace_then_smoke_commit(transaction):
    sync, candidate, command, chown = transaction
    original = sync.config.read_bytes()
    record(sync)
    old_hash = sync.record.read_bytes()
    sync.prepare(candidate)
    assert sync.config.read_bytes() == candidate.read_bytes()
    assert stat.S_IMODE(sync.config.stat().st_mode) == 0o644
    assert sync.backup.read_bytes() == original
    assert stat.S_IMODE(sync.backup.stat().st_mode) == 0o600
    assert stat.S_IMODE(sync.state.stat().st_mode) == 0o700
    assert sync.record.read_bytes() == old_hash  # never bless before smoke
    assert command.call_args.args[0][:2] == ['caddy', 'validate']
    sync.reload()
    sync.commit()
    assert sync.record.read_text().strip() == caddy_sync.digest(candidate.read_bytes())
    assert stat.S_IMODE(sync.record.stat().st_mode) == 0o600
    assert not sync.pending.exists()
    assert chown.call_args.args[1:] == (0, 0)


@pytest.mark.parametrize('failure', ['validate', 'reload', 'smoke'])
def test_failure_restores_bytes_owner_mode_and_hash(transaction, failure):
    sync, candidate, command, chown = transaction
    original, mode = sync.config.read_bytes(), stat.S_IMODE(sync.config.stat().st_mode)
    record(sync)
    old_hash = sync.record.read_bytes()
    calls = []

    def fail_once(args, check=False):
        calls.append(args)
        if ((failure == 'validate' and args[0] == 'caddy')
                or (failure == 'reload' and args[:2] == ['systemctl', 'reload'])):
            if sum(call == args for call in calls) == 1:
                raise subprocess.CalledProcessError(1, args)
        return subprocess.CompletedProcess(args, 0)

    command.side_effect = fail_once
    if failure == 'validate':
        with pytest.raises(subprocess.CalledProcessError):
            sync.prepare(candidate)
    else:
        sync.prepare(candidate)
        # Prove the original owner/group are restored, even when non-default.
        metadata = sync.metadata()
        metadata.update(uid=123, gid=456)
        caddy_sync.replace(sync.pending, caddy_sync.json.dumps(metadata).encode())
        if failure == 'reload':
            with pytest.raises(subprocess.CalledProcessError):
                sync.reload()
        sync.rollback()
        assert any(call.args[1:] == (123, 456) for call in chown.call_args_list)
    assert sync.config.read_bytes() == original
    assert stat.S_IMODE(sync.config.stat().st_mode) == mode
    assert sync.record.read_bytes() == old_hash
    assert ['systemctl', 'reload', 'caddy'] in calls
    assert not sync.pending.exists()


@pytest.mark.parametrize('tracked', [False, True])
def test_manual_edit_or_untracked_difference_is_refused(transaction, capsys, tracked):
    sync, candidate, command, _ = transaction
    if tracked:
        record(sync, b'last deployed config')
    original = sync.config.read_bytes(), sync.config.stat()
    sync.prepare(candidate)
    sync.commit()
    assert sync.config.read_bytes() == original[0] and sync.config.stat() == original[1]
    assert 'overwrite REFUSED' in capsys.readouterr().err
    assert not sync.pending.exists() and not sync.backup.exists()
    command.assert_not_called()


def test_first_identical_run_records_only_after_smoke(transaction):
    sync, candidate, command, _ = transaction
    candidate.write_bytes(sync.config.read_bytes())
    before = sync.config.stat()
    sync.prepare(candidate)
    assert not sync.record.exists()
    sync.commit()
    assert sync.config.stat() == before
    assert sync.record.read_text().strip() == caddy_sync.digest(candidate.read_bytes())
    assert not sync.backup.exists()
    command.assert_not_called()


def test_failed_first_enrolment_keeps_hash_absent(transaction):
    sync, candidate, _, _ = transaction
    candidate.write_bytes(sync.config.read_bytes())
    sync.prepare(candidate)
    sync.rollback()
    assert not sync.record.exists()


def test_operator_edit_during_validate_is_not_overwritten(transaction):
    sync, candidate, command, _ = transaction
    record(sync)
    def edit(args, check=False):
        sync.config.write_bytes(b'operator edit during validate')
        return subprocess.CompletedProcess(args, 0)
    command.side_effect = edit
    with pytest.raises(ValueError, match='changed during validation'):
        sync.prepare(candidate)
    assert sync.config.read_bytes() == b'operator edit during validate'
    assert command.call_count == 1


def test_failed_recovery_retains_private_evidence_and_blocks_next_prepare(transaction):
    sync, candidate, command, _ = transaction
    record(sync)
    sync.prepare(candidate)
    command.side_effect = subprocess.CalledProcessError(1, ['systemctl'])
    with pytest.raises(subprocess.CalledProcessError):
        sync.rollback()
    assert sync.pending.exists() and sync.backup.exists()
    with pytest.raises(ValueError, match='Unfinished'):
        sync.prepare(candidate)


@pytest.mark.parametrize('target', ['state', 'record', 'config'])
def test_symlinks_are_refused(transaction, tmp_path, target):
    sync, candidate, _, _ = transaction
    record(sync)
    path = dict(state=sync.state, record=sync.record, config=sync.config)[target]
    moved = tmp_path / ('real-' + target)
    path.rename(moved)
    path.symlink_to(moved)
    with pytest.raises((OSError, ValueError)):
        sync.prepare(candidate)


def test_insecure_hash_mode_is_refused(transaction):
    sync, candidate, _, _ = transaction
    record(sync)
    sync.record.chmod(0o644)
    with pytest.raises(ValueError, match='0600'):
        sync.prepare(candidate)


def test_first_service_start_preserves_legacy_behavior(transaction):
    sync, _, command, _ = transaction
    command.side_effect = lambda args, check=False: subprocess.CompletedProcess(
        args, 3 if args[1] == 'is-active' else 0)
    sync.reload()
    assert command.call_args.args[0] == ['systemctl', 'start', 'caddy']
