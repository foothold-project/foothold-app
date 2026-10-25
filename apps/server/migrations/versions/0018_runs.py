"""Durable direct-agent run records and atomic report receipts."""
from alembic import op

revision = '0018'
down_revision = '0017'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""CREATE TABLE runs (
    id UUID NOT NULL,
    robot_id UUID NOT NULL,
    assignment_id UUID,
    simulation BOOLEAN NOT NULL,
    scenario_version_id UUID NOT NULL,
    floor_id UUID NOT NULL,
    map_version_id UUID NOT NULL,
    started_by UUID NOT NULL,
    device_id UUID NOT NULL,
    surface TEXT NOT NULL,
    screen_id UUID NOT NULL,
    agent_instance_id UUID NOT NULL,
    status TEXT NOT NULL,
    step INTEGER DEFAULT 0 NOT NULL,
    progress JSONB,
    wait_reason TEXT,
    fail_code TEXT,
    fail_message TEXT,
    emergency BOOLEAN DEFAULT false NOT NULL,
    emergency_reason TEXT,
    plan JSONB NOT NULL,
    path_actual JSONB DEFAULT '[]'::jsonb NOT NULL,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    ended_at TIMESTAMP WITH TIME ZONE,
    org_id UUID NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (org_id, id),
    FOREIGN KEY(org_id, robot_id) REFERENCES robots (org_id, id),
    FOREIGN KEY(org_id, assignment_id) REFERENCES assignments (org_id, id),
    FOREIGN KEY(org_id, scenario_version_id) REFERENCES scenario_versions (org_id, id),
    FOREIGN KEY(org_id, started_by) REFERENCES users (org_id, id),
    FOREIGN KEY(org_id, map_version_id) REFERENCES map_versions (org_id, id),
    FOREIGN KEY(org_id, floor_id) REFERENCES floors (org_id, id),
    CONSTRAINT run_real_assignment CHECK (simulation OR assignment_id IS NOT NULL),
    CONSTRAINT run_status CHECK (status IN ('QUEUED','PREPARING','MOVING','RUNNING','AT_WAYPOINT','PERFORMING','WAIT_CONFIRM','PAUSED','COMPLETED','FAILED','CANCELED','ABORTED'))
)""")
    op.execute("CREATE UNIQUE INDEX one_active_run ON runs (robot_id) WHERE status NOT IN ('COMPLETED','FAILED','CANCELED','ABORTED')")
    op.execute("""CREATE TABLE run_steps (
    run_id UUID NOT NULL,
    idx INTEGER NOT NULL,
    status TEXT NOT NULL,
    arrived_at TIMESTAMP WITH TIME ZONE,
    done_at TIMESTAMP WITH TIME ZONE,
    results JSONB DEFAULT '{}'::jsonb NOT NULL,
    org_id UUID NOT NULL,
    PRIMARY KEY (run_id, idx),
    FOREIGN KEY(org_id, run_id) REFERENCES runs (org_id, id),
    CONSTRAINT run_step_idx CHECK (idx >= 0 AND idx < 200),
    CONSTRAINT run_step_status CHECK (status IN ('PENDING','ARRIVED','DONE','SKIPPED','FAILED'))
)""")
    op.execute("""CREATE TABLE run_reports (
    robot_id UUID NOT NULL,
    agent_instance_id UUID NOT NULL,
    report_seq BIGINT NOT NULL,
    request_hash TEXT NOT NULL,
    monotonic_s FLOAT NOT NULL,
    at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    org_id UUID NOT NULL,
    PRIMARY KEY (robot_id, agent_instance_id, report_seq),
    FOREIGN KEY(org_id, robot_id) REFERENCES robots (org_id, id),
    CONSTRAINT run_report_seq CHECK (report_seq >= 0)
)""")
    op.create_foreign_key('events_run_fk', 'events', 'runs', ['org_id', 'run_id'], ['org_id', 'id'])
    op.execute('GRANT SELECT, INSERT ON runs, run_steps, run_reports TO fh_app')
    op.execute('GRANT UPDATE (status, step, progress, wait_reason, fail_code, path_actual, ended_at) ON runs TO fh_app')
    op.execute('GRANT UPDATE (status, arrived_at, done_at, results) ON run_steps TO fh_app')
    op.execute('GRANT SELECT ON runs, run_steps, run_reports TO fh_readonly')


def downgrade():
    op.execute("""DO $$ BEGIN IF EXISTS (SELECT 1 FROM runs) THEN
        RAISE EXCEPTION 'Retire run records explicitly before downgrade';
        END IF; END $$""")
    op.drop_constraint('events_run_fk', 'events', type_='foreignkey')
    for table in ('run_reports', 'run_steps', 'runs'):
        op.drop_table(table)
