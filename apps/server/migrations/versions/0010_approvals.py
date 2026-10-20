"""S4a map approvals; snapshot content stays immutable, status may transition."""
from alembic import op

revision = '0010'
down_revision = '0009'
branch_labels = None
depends_on = None


def upgrade():
    op.execute('''CREATE TABLE approvals (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        org_id UUID NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id UUID NOT NULL,
        base_ref_type TEXT,
        base_ref_id UUID,
        requester_id UUID NOT NULL,
        reason TEXT NOT NULL,
        decider_id UUID,
        decision_comment TEXT,
        emergency BOOLEAN DEFAULT false NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        decided_at TIMESTAMPTZ,
        UNIQUE (org_id, id),
        FOREIGN KEY (org_id, requester_id) REFERENCES users(org_id, id),
        FOREIGN KEY (org_id, decider_id) REFERENCES users(org_id, id),
        FOREIGN KEY (org_id, target_id) REFERENCES map_versions(org_id, id),
        FOREIGN KEY (org_id, base_ref_id) REFERENCES map_versions(org_id, id),
        CONSTRAINT approval_kind CHECK (kind IN ('MAP_REVISION','MAP_ROLLBACK')),
        CONSTRAINT approval_status CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELED','STALE')),
        CONSTRAINT approval_target_type CHECK (target_type = 'map_version'),
        CONSTRAINT approval_base_ref CHECK ((base_ref_id IS NULL AND base_ref_type IS NULL) OR
            (base_ref_id IS NOT NULL AND base_ref_type IS NOT NULL AND base_ref_type = 'map_version')),
        CONSTRAINT approval_reject_reason CHECK (status != 'REJECTED' OR
            (decision_comment IS NOT NULL AND decision_comment ~ '[^[:space:]]')),
        CONSTRAINT approval_decision CHECK (
            (status = 'PENDING' AND decided_at IS NULL AND decider_id IS NULL) OR
            (status != 'PENDING' AND decided_at IS NOT NULL AND decider_id IS NOT NULL))
    )''')
    op.create_index('approvals_org_status_created', 'approvals', ['org_id', 'status', 'created_at'])
    op.create_index('approvals_requester_status', 'approvals', ['requester_id', 'status'])
    op.execute("CREATE UNIQUE INDEX approvals_pending_target ON approvals (target_type, target_id) WHERE status = 'PENDING'")
    op.execute('ALTER TABLE events ADD CONSTRAINT events_approval_fk FOREIGN KEY (org_id, approval_id) REFERENCES approvals(org_id, id)')
    op.drop_constraint('map_version_status', 'map_versions', type_='check')
    op.create_check_constraint('map_version_status', 'map_versions', "status IN ('PENDING','APPROVED','REJECTED','CANCELED','SUPERSEDED')")
    op.execute('GRANT SELECT, INSERT, UPDATE ON approvals TO fh_app')
    op.execute('GRANT SELECT ON approvals TO fh_readonly')
    op.execute('GRANT UPDATE (status) ON map_versions TO fh_app')


def downgrade():
    # Fail atomically if canceled snapshots exist; never rewrite audit history
    # or silently reclassify a canceled request as rejected during rollback.
    op.drop_constraint('map_version_status', 'map_versions', type_='check')
    op.create_check_constraint('map_version_status', 'map_versions', "status IN ('PENDING','APPROVED','REJECTED','SUPERSEDED')")
    op.execute('REVOKE UPDATE (status) ON map_versions FROM fh_app')
    op.drop_constraint('events_approval_fk', 'events', type_='foreignkey')
    op.drop_table('approvals')
