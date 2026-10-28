# Development-server simulation deployment fence

The API and simulation manager use the same release. A dev merge remains eligible
for automatic deployment within the timer interval when there is no simulation
session and no unproven cleanup. The manager acquires a shared flock and durable
`state/unproven` latch before creating a world. Only the existing full cleanup
proof removes the latch. A crash or unproven cleanup blocks deployment and next
start pending manual evidence audit. Never remove the latch to pass a test.
A proven pre-creation world/resource rejection clears its lease; it created no
session. An idle manager holds no session lease and does not block deployment.

Automatic/manual deploy and rollback hold the exclusive flock from candidate
admission through build, activation, manager readiness, API smoke and recovery.
This blocks concurrent session creation, including during manager restart.
After preparing the candidate they stop the idle manager, prove its unit/PID/
cgroup exit, switch the release and start a new manager using the same `current`
path as the API. They verify native-single readiness and the new manager's real
working directory. A failed transition stops the candidate manager and restores
the prior API/manager pair under the same fence; failed SHA recording retains the
existing autodeploy rules. A busy session/latch is a skip, never a failed SHA.
There is no human SHA-pin step and no simulator session is automatically started.

Before provisioning simulation, install reviewed `common.sh`, `autodeploy.sh`,
`deploy.sh`, `rollback.sh`, `prepare-release.sh`, and `sim_control.py` into existing
root-owned deploy-tools while holding the existing deployment lock. Atomically
replace files, common.sh first; merging a PR does not update installed tools.
Keep the automatic deployment timer enabled. Provision
`/var/lib/foothold-sim/guard` root-owned 0755, `deploy.lock` root:foothold-sim 0660,
and `state` foothold-sim:foothold-sim 0700. Never replace the lock inode in use.
Install `foothold-simmgr.service` into the dedicated user's manager. Its fixed
`FH_SIM_DEPLOY_GUARD_DIR` overrides private env, and `Restart=no` prevents retries.
The private `/etc/foothold-sim/manager.env` and catalogue are root:foothold-sim 0640;
its referenced service credential is an independent foothold-sim-owned 0600 file.

The release includes apps/simmgr and apps/agent with tools/sim and tools/nav2.
External source, model/policy, private maps and credentials are not archived.
Offline checks cover actual temporary flock contention, lifecycle failure
latches, bundle isolation and mocked manager transitions. Live installation,
EGL, Gazebo/ROS, HTTPS, driving and live rollback are separate acceptance steps.
