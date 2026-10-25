"""Durable report quarantine and authenticated fixed-plan map access."""
from alembic import op

revision = '0019'
down_revision = '0018'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""CREATE TABLE run_report_rejections (
    robot_id UUID NOT NULL,
    agent_instance_id UUID NOT NULL,
    report_seq BIGINT NOT NULL,
    request_hash TEXT NOT NULL,
    monotonic_s FLOAT NOT NULL,
    run_id UUID,
    code TEXT NOT NULL,
    at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    org_id UUID NOT NULL,
    PRIMARY KEY (robot_id, agent_instance_id, report_seq, request_hash),
    FOREIGN KEY(org_id, robot_id) REFERENCES robots (org_id, id),
    CONSTRAINT run_rejection_seq CHECK (report_seq >= 0)
)""")
    op.execute("""CREATE TABLE agent_plan_maps (
    robot_id UUID NOT NULL,
    scenario_version_id UUID NOT NULL,
    map_version_id UUID NOT NULL,
    org_id UUID NOT NULL,
    PRIMARY KEY (robot_id, scenario_version_id, map_version_id),
    FOREIGN KEY(org_id, robot_id) REFERENCES robots (org_id, id),
    FOREIGN KEY(org_id, scenario_version_id) REFERENCES scenario_versions (org_id, id),
    FOREIGN KEY(org_id, map_version_id) REFERENCES map_versions (org_id, id)
)""")
    op.execute('GRANT SELECT, INSERT ON run_report_rejections, agent_plan_maps TO fh_app')
    op.execute('GRANT SELECT ON run_report_rejections, agent_plan_maps TO fh_readonly')


def downgrade():
    op.execute("""DO $$ BEGIN IF EXISTS (SELECT 1 FROM run_report_rejections) THEN
        RAISE EXCEPTION 'Retire run rejection records explicitly before downgrade';
        END IF; END $$""")
    op.drop_table('agent_plan_maps')
    op.drop_table('run_report_rejections')
