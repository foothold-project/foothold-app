"""S5b assignments and short-lived transactional idempotency receipts."""
from alembic import op

revision = '0013'
down_revision = '0012'
branch_labels = None
depends_on = None


def upgrade():
    op.execute('ALTER TABLE scenario_versions ADD CONSTRAINT scenario_versions_org_id_id_key UNIQUE (org_id, id)')
    op.execute('''CREATE TABLE assignments (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY, org_id UUID NOT NULL,
        scenario_version_id UUID NOT NULL, robot_id UUID NOT NULL,
        status TEXT NOT NULL, approval_id UUID, memo TEXT NOT NULL,
        created_by UUID NOT NULL, created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        removed_at TIMESTAMPTZ,
        UNIQUE (org_id, id),
        FOREIGN KEY (org_id, scenario_version_id) REFERENCES scenario_versions(org_id, id),
        FOREIGN KEY (org_id, robot_id) REFERENCES robots(org_id, id),
        FOREIGN KEY (org_id, created_by) REFERENCES users(org_id, id),
        FOREIGN KEY (org_id, approval_id) REFERENCES approvals(org_id, id),
        CONSTRAINT assignment_status CHECK (status IN ('PENDING','ACTIVE','REJECTED','REMOVED')),
        CONSTRAINT assignment_removed CHECK ((status = 'REMOVED') = (removed_at IS NOT NULL))
    )''')
    op.execute("CREATE UNIQUE INDEX assignments_live_pair ON assignments(robot_id, scenario_version_id) WHERE status IN ('ACTIVE','PENDING')")
    op.execute('CREATE INDEX assignments_org_created ON assignments(org_id, created_at, id)')
    # Generated discriminator columns keep real tenant FKs on both target kinds;
    # target_id remains immutable and clients continue using the same wire shape.
    op.drop_constraint('approvals_org_id_target_id_fkey', 'approvals', type_='foreignkey')
    op.drop_constraint('approval_kind', 'approvals', type_='check')
    op.drop_constraint('approval_target_type', 'approvals', type_='check')
    op.execute("ALTER TABLE approvals ADD COLUMN map_target_id UUID GENERATED ALWAYS AS (CASE WHEN target_type = 'map_version' THEN target_id END) STORED")
    op.execute("ALTER TABLE approvals ADD COLUMN assignment_target_id UUID GENERATED ALWAYS AS (CASE WHEN target_type = 'assignment' THEN target_id END) STORED")
    op.execute('ALTER TABLE approvals ADD CONSTRAINT approval_map_target_fk FOREIGN KEY (org_id, map_target_id) REFERENCES map_versions(org_id, id)')
    op.execute('ALTER TABLE approvals ADD CONSTRAINT approval_assignment_target_fk FOREIGN KEY (org_id, assignment_target_id) REFERENCES assignments(org_id, id)')
    op.create_check_constraint('approval_kind', 'approvals', "kind IN ('MAP_REVISION','MAP_ROLLBACK','SCENARIO_ASSIGNMENT')")
    op.create_check_constraint('approval_target_type', 'approvals', "(kind IN ('MAP_REVISION','MAP_ROLLBACK') AND target_type = 'map_version') OR (kind = 'SCENARIO_ASSIGNMENT' AND target_type = 'assignment' AND base_ref_id IS NULL)")
    op.execute('''CREATE TABLE idempotency_receipts (
        org_id UUID NOT NULL, user_id UUID NOT NULL, key TEXT NOT NULL,
        request_hash TEXT NOT NULL, response JSONB, status_code INTEGER,
        expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (user_id, key),
        FOREIGN KEY (org_id, user_id) REFERENCES users(org_id, id),
        CONSTRAINT receipt_key CHECK (key ~ '^[A-Za-z0-9._:-]{1,128}$')
    )''')
    op.execute('GRANT SELECT, INSERT ON assignments, idempotency_receipts TO fh_app')
    op.execute('GRANT UPDATE (status, approval_id, removed_at) ON assignments TO fh_app')
    op.execute('GRANT UPDATE (request_hash, response, status_code, expires_at) ON idempotency_receipts TO fh_app')
    op.execute('GRANT SELECT ON assignments, idempotency_receipts TO fh_readonly')


def downgrade():
    # Refuse lossy downgrade once assignment decisions have entered audit history.
    op.execute("DO $$ BEGIN IF EXISTS (SELECT 1 FROM approvals WHERE kind='SCENARIO_ASSIGNMENT') THEN RAISE EXCEPTION 'assignment approval history requires backup before downgrade'; END IF; END $$")
    op.drop_table('idempotency_receipts')
    op.drop_constraint('approval_assignment_target_fk', 'approvals', type_='foreignkey')
    op.drop_constraint('approval_map_target_fk', 'approvals', type_='foreignkey')
    op.drop_constraint('approval_target_type', 'approvals', type_='check')
    op.drop_constraint('approval_kind', 'approvals', type_='check')
    op.drop_column('approvals', 'assignment_target_id')
    op.drop_column('approvals', 'map_target_id')
    op.create_foreign_key('approvals_org_id_target_id_fkey', 'approvals', 'map_versions', ['org_id', 'target_id'], ['org_id', 'id'])
    op.create_check_constraint('approval_kind', 'approvals', "kind IN ('MAP_REVISION','MAP_ROLLBACK')")
    op.create_check_constraint('approval_target_type', 'approvals', "target_type = 'map_version'")
    op.drop_table('assignments')
    op.drop_constraint('scenario_versions_org_id_id_key', 'scenario_versions', type_='unique')
