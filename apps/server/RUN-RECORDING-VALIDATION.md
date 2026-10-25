# Scenario/1 server data and recording

Scope: `apps/server/**`, based on dev `c03b648` (contracts PR #101).
This change does not start a simulator, command a robot, or deploy a service.

## Behavior

- `GET /api/v1/agent/scenarios/{id}?version=n` authenticates the existing agent
  bearer token against its organization/robot, requires an explicit version,
  and returns `AgentScenario` with stored waypoint order, finish and immutable
  mission-version display names. It never substitutes the latest version.
- Simulation eligibility comes from the authenticated robot row. Simulation
  reads skip assignment, approval and SF-12. Real reads and real RUN_STARTED
  remain denied because the current contracts cannot carry the required proof.
- `0018` creates organization-bound `runs`, `run_steps`, `run_reports`, the
  `events.run_id` FK and a per-robot active-run unique index that includes
  CANCELED as terminal. Simulation runs allow null assignment; real rows do not.
- RUN_STARTED resolves the fixed scenario internally and stores the plan,
  finish, user/device/surface/screen, map and simulation provenance. It creates
  PENDING steps without creating fake assignments or approvals.
- Report identity is optional for old producers. New identified reports share
  one per-robot, per-agent-instance sequence across events and run updates.
  First sequence 1 (also 0 for compatibility) is accepted. Gaps, changed payload
  replays and decreasing monotonic timestamps close the data connection without
  ACK; the agent must replay its durable outbox. Exact replays receive the same
  ACK without duplicating records. Receipts and affected records commit together.
- The bounded report queue and dedicated write pool keep recording I/O out of
  the inbound control/telemetry loop. `run.recorded` follows DB commit. Failed
  storage never produces a receipt. Reconnects preserve the DB receipt ledger.
- PAUSED reasons, CANCELED/PAUSE_TIMEOUT and terminal timestamps are recorded.
  Late MOVING reports cannot reopen terminal rows. Waypoint ARRIVED/DONE records
  use DISPLAY_ONLY results and retain fixed mission identity/name.
- Matching accepted poses are sampled at most once per second; map/floor mismatch
  cannot add a path sample. This is receive-time sampling, not a physical arrival
  or motion validation claim.
- Only simulation phone passes gain `run_cancel`, and only a current same-org
  owner/operator or admin can receive true. Real admin view/control and PC access
  stay blocked in this first release, per coordinator direction.
- Both old server `run.control pause` producers are removed. Servers issue no
  run.start/run.control/run.confirm frames. Resume secrets are stripped from
  event data recursively and are absent from run tables, ACKs and plan responses.

## Contract gaps and follow-up

- AgentScenario GET and RunStarted lack assignment_id, start-user proof and SF-12
  proof binding. Real execution remains fail-closed; it needs a separate contract
  and implementation before enabling real runs. Real admin cancellation-only
  phone view is likewise deferred; real access policy is unchanged here.
- RunStarted lacks the agent-verified plan payload. The server reconstructs a
  snapshot from the immutable scenario and mission versions; agent plan/map/Nav2
  validation remains the agent's responsibility.
- RunRecorded has no explicit negative/replay request model. Sequence gaps use
  WS close 1013/RUN_REPORT_SEQUENCE and reconnect replay, agreed with coordinator.
- Merge agent work 2a before this server work: old ticket verifiers reject the
  optional run_cancel claim. Combined-agent acceptance is a separate integration
  check, not established by server-only tests.
- No real robot, physical stopping/arrival tolerance, phone, Nav2, simulation,
  production DB or deployed service is validated by these tests.

## Validation

Validation results are recorded in the Draft PR, including the one full server
suite run, focused checks and the selected authorization mutation.
Private PostgreSQL uses temporary Unix sockets; socket allocation is constrained
by `FH_TEST_PORT_RANGE=9590:9599`. No package installation or sudo is used.

## Rollback

Revert the feature commit(s) using a new git revert commit; Git does not deploy.
Application rollback may keep the additive tables and receipts. Back up and
explicitly retire run/event history before requesting alembic downgrade to 0017:
the migration refuses a populated runs table to avoid silently deleting history.
An empty database supports upgrade head / downgrade base / upgrade head.

### Executed results (2026-10-25)

- Final focused regression: **86 passed**, including runs/steps/receipts, migration
  round-trip + metadata match, events/permissions/CSV, the three affected downgrade
  guards, floor-context filtering, realtime reconnect/takeover/terminal behavior.
- Full server suite, exactly once before the final targeted corrections:
  **939 passed, 7 failed, 7 errors** / 953 collected / 1099.46 seconds.
  The conditional command checked MemAvailable >= 2621440 kB; the preceding
  observation was 6534036 kB. The 7 fixture errors (new Event.run_id FK) and
  3 downgrade-head expectation failures were fixed and included in the final
  passing focused regression. The entire suite was not repeated.
- The remaining 4 failures are the approved agent-2a dependency: old Verifier
  rejects run_cancel, so pc-control/pc-view WebSocket round-trips and the two
  untrusted-simulation gate cases return TICKET_INVALID. They require validation
  after merging the agent's contract support; no agent files were changed here.
- Selected authorization mutation: forcing run_cancel=true for a non-owner was
  **KILLED (1/1)** by the new issuer-scope test. The mutation was applied only to
  the isolated test process's method, without changing source files.
- `git diff --check`: passed. No production/preview service contact, simulator
  start, package installation, sudo, or changes outside apps/server.

Final focused command (using an existing test interpreter):

```sh
FH_TEST_PORT_RANGE=9590:9599 python -m pytest \
  apps/server/tests/test_runs.py apps/server/tests/test_migrations.py \
  apps/server/tests/test_events.py \
  apps/server/tests/test_assignments.py::test_populated_assignment_approval_downgrade_refuses_without_losing_history \
  apps/server/tests/test_assignments.py::test_direct_active_assignment_downgrade_refuses_without_losing_history \
  apps/server/tests/test_sim_maps.py::test_downgrade_refuses_to_erase_simulation_provenance \
  apps/server/tests/test_floor_auto.py apps/server/tests/test_realtime.py \
  apps/server/tests/test_realtime_review.py::test_r6_run_takeover_and_i1_bound_run_lease \
  apps/server/tests/test_realtime_r2.py::test_n8_run_takeover_has_no_duplicate_release \
  apps/server/tests/test_realtime_r3.py::test_c3_matching_current_run_terminal_releases_only_its_lease \
  -q --tb=short
```

Full command, executed once:

```sh
if awk '/MemAvailable/ {exit !($2 >= 2621440)}' /proc/meminfo; then
  FH_TEST_PORT_RANGE=9590:9599 python -m pytest apps/server -q --tb=short
fi
```

Cross-model reviews required by FAST remain the coordinator's merge gate.
