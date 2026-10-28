# Development-server simulation deployment fence

The server simulation is a manually pinned release. Automatic dev deployment must
never replace an API underneath a running manager, including an idle manager.
`FH_SIM_DEPLOY_GUARD_DIR` enables the manager lifetime shared flock; deployments
hold the exclusive flock through activation, smoke checks and failure recovery.
Startup creates a durable `state/unproven` latch. Only successful shutdown after
existing native cleanup proof removes it. A crash, failed startup or unproven
cleanup blocks deployment and manager restart pending a manual evidence audit.
Do not remove that latch to make a test pass.

Before provisioning or starting simulation, install the reviewed versions of
`common.sh`, `autodeploy.sh`, `deploy.sh` and `rollback.sh` into the existing
root-owned deploy-tools directory while holding the existing deployment lock.
Use atomic file replacement, installing common.sh first. Merging a PR does not
update those installed tools. Keep the automatic deployment timer enabled.
Then provision `/var/lib/foothold-sim/guard` root-owned 0755, its `deploy.lock`
root:foothold-sim 0660, and `state` foothold-sim:foothold-sim 0700. Never replace
the lock inode while either side may hold it. The simulation account cannot
rename or remove the root-owned lock.

For a paired transition: block new starts, ask the existing manager for normal
STOP/zero and full native cleanup, stop the manager, and confirm the latch is
absent. Stage the reviewed, root-owned simulation release at
`/opt/foothold/sim-current`, whose COMMIT must match the API candidate exactly.
Only then deploy that same SHA, verify API smoke, and manually start the manager
with the reviewed private configuration. Hold the deployment lock while staging
the simulation pointer. Never point simulation at the automatically moving API
`current` symlink. Rollback uses the same guard and requires the same paired idle
transition; its target must also match the simulation pin. An unconfirmed cleanup
or failed transition leaves the slot locked and does not restart simulation.

Offline checks: `bash deploy/tests/test_sim_guard.sh`, existing deployment shell
checks, and `pytest apps/simmgr/tests`. These use synthetic managers and temporary
flock files; they do not start ROS or Gazebo. Live installation, EGL, HTTPS,
world/agent operation and absence proof remain separate acceptance steps.
