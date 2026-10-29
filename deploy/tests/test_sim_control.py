"""Mocked user-manager/HTTP transitions; no host service, process or socket use."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from deploy import sim_control as sim


class TransitionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.guard = Path(self.tmp.name)
        (self.guard / 'state').mkdir()
        self.patch = patch.object(sim, 'GUARD', self.guard)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        packages = patch.object(sim, 'PACKAGE_LATCH', self.guard / 'packages-unproven')
        packages.start()
        self.addCleanup(packages.stop)

    def test_stop_proves_exit_and_rejects_surviving_pid(self):
        active = dict(LoadState='loaded', ActiveState='active', MainPID='42', ControlGroup='')
        idle = dict(LoadState='loaded', ActiveState='inactive', MainPID='0')
        with patch.object(sim, 'state', side_effect=[active, idle]), patch.object(sim, 'userctl') as ctl:
            sim.stop()
            ctl.assert_called_once_with('stop', sim.UNIT)
        with patch.object(sim, 'state', side_effect=[active, active]), patch.object(sim, 'userctl'):
            with self.assertRaises(ValueError):
                sim.stop()

    def test_latch_never_stops_or_restarts_manager(self):
        (self.guard / 'state/unproven').touch()
        with patch.object(sim, 'userctl') as ctl:
            for operation in (sim.stop, sim.start):
                with self.assertRaises(ValueError):
                    operation()
            ctl.assert_not_called()

    def test_root_activation_latch_blocks_stop_and_start(self):
        (self.guard / 'setup-unproven').touch()
        with patch.object(sim, 'userctl') as ctl:
            for operation in (sim.stop, sim.start):
                with self.assertRaises(ValueError):
                    operation()
            ctl.assert_not_called()

    def test_package_transaction_latch_blocks_manager_transition(self):
        sim.PACKAGE_LATCH.touch()
        with patch.object(sim, 'userctl') as ctl:
            with self.assertRaises(ValueError):
                sim.start()
            ctl.assert_not_called()

    def test_start_waits_for_current_release_readiness(self):
        running = dict(ActiveState='active', MainPID='42')
        with patch.object(sim, 'stop') as stop, patch.object(sim, 'userctl') as ctl, \
                patch.object(sim, 'state', return_value=running), \
                patch.object(sim, 'same_release', return_value=True), \
                patch.object(sim, 'ready', side_effect=[ValueError(), None]) as ready, \
                patch.object(sim.time, 'sleep'):
            sim.start()
            stop.assert_called_once()
            ctl.assert_called_once_with('start', sim.UNIT)
            self.assertEqual(ready.call_count, 2)

    def test_stale_release_or_failed_readiness_never_succeeds(self):
        for same in (False, True):
            with patch.object(sim, 'stop'), patch.object(sim, 'userctl'), \
                    patch.object(sim, 'state', return_value=dict(ActiveState='active', MainPID='42')), \
                    patch.object(sim, 'same_release', return_value=same), \
                    patch.object(sim, 'ready', side_effect=ValueError()), patch.object(sim.time, 'sleep'):
                with self.assertRaises(ValueError):
                    sim.start()


if __name__ == '__main__':
    unittest.main()


def test_release_pending_barrier_blocks_transition_without_original_name(tmp_path):
    for marker in (tmp_path/'packages',tmp_path/'setup-unproven'):
        pending=marker.with_name(marker.name+'.release-pending');pending.touch()
        with patch.object(sim,'PACKAGE_LATCH',tmp_path/'packages'),patch.object(sim,'GUARD',tmp_path),patch.object(sim,'userctl') as ctl:
            import pytest
            with pytest.raises(ValueError):sim.start()
            ctl.assert_not_called()
        pending.unlink()
