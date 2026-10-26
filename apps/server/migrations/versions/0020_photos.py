"""Agent photo identity, immutable receipts and bounded file storage."""
from alembic import op

revision = '0020'
down_revision = '0019'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""CREATE TABLE photos (
        id UUID PRIMARY KEY,
        org_id UUID NOT NULL,
        robot_id UUID NOT NULL,
        run_id UUID NOT NULL,
        waypoint_idx INTEGER NOT NULL,
        step_idx INTEGER NOT NULL,
        source TEXT NOT NULL,
        captured_at TIMESTAMPTZ NOT NULL,
        sha256 TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        path TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL,
        stored_at TIMESTAMPTZ,
        UNIQUE (org_id, id),
        UNIQUE (org_id, robot_id, idempotency_key),
        UNIQUE (org_id, run_id, waypoint_idx, step_idx),
        FOREIGN KEY (org_id, robot_id) REFERENCES robots(org_id, id),
        FOREIGN KEY (org_id, run_id) REFERENCES runs(org_id, id),
        FOREIGN KEY (run_id, waypoint_idx) REFERENCES run_steps(run_id, idx),
        CONSTRAINT photo_status CHECK (status IN ('STORED','FAILED')),
        CONSTRAINT photo_source CHECK (source = 'rgb'),
        CONSTRAINT photo_size CHECK (byte_length BETWEEN 4 AND 65536),
        CONSTRAINT photo_step CHECK (step_idx BETWEEN 0 AND 99),
        CONSTRAINT photo_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT photo_receipt CHECK ((status = 'STORED') = (stored_at IS NOT NULL))
    )""")
    op.execute('GRANT SELECT, INSERT ON photos TO fh_app')
    op.execute('GRANT UPDATE (status, stored_at) ON photos TO fh_app')
    op.execute('GRANT SELECT ON photos TO fh_readonly')


def downgrade():
    op.execute("""DO $$ BEGIN IF EXISTS (SELECT 1 FROM photos) THEN
        RAISE EXCEPTION 'Retire photo records and files explicitly before downgrade';
        END IF; END $$""")
    op.drop_table('photos')
