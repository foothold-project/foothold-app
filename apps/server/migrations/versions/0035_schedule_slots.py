"""로봇 일정 칸. 같은 로봇 겹침은 서버가 로봇 행 잠금 아래에서 409 로 막는다."""
from alembic import op

revision = '0035'
down_revision = '0034'
branch_labels = None
depends_on = None


def upgrade():
    op.execute('''CREATE TABLE schedule_slots (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY, org_id UUID NOT NULL,
        robot_id UUID NOT NULL, scenario_id UUID, scenario_version INTEGER, gait TEXT,
        start_at TIMESTAMPTZ NOT NULL, end_at TIMESTAMPTZ NOT NULL, kind TEXT NOT NULL,
        assignment_id UUID, memo TEXT NOT NULL,
        created_by UUID NOT NULL, created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        UNIQUE (org_id, id),
        FOREIGN KEY (org_id, robot_id) REFERENCES robots(org_id, id),
        FOREIGN KEY (org_id, assignment_id) REFERENCES assignments(org_id, id),
        FOREIGN KEY (org_id, created_by) REFERENCES users(org_id, id),
        CONSTRAINT schedule_slot_order CHECK (end_at > start_at),
        CONSTRAINT schedule_slot_kind CHECK (kind IN ('CONFIRMED','DRAFT','BATTERY_SWAP')),
        CONSTRAINT schedule_slot_gait CHECK (gait IS NULL OR gait IN ('classic','sport','start','ame2')),
        CONSTRAINT schedule_slot_scenario_pair CHECK ((scenario_id IS NULL) = (scenario_version IS NULL)),
        CONSTRAINT schedule_slot_scenario_required CHECK (scenario_id IS NOT NULL OR kind = 'BATTERY_SWAP')
    )''')
    op.execute('CREATE INDEX schedule_slots_robot_time ON schedule_slots(org_id, robot_id, start_at)')
    op.execute('GRANT SELECT, INSERT, UPDATE, DELETE ON schedule_slots TO fh_app')
    op.execute('GRANT SELECT ON schedule_slots TO fh_readonly')


def downgrade():
    op.execute("DO $$ BEGIN IF EXISTS (SELECT 1 FROM schedule_slots LIMIT 1) THEN RAISE EXCEPTION 'schedule slots require backup before downgrade'; END IF; END $$")
    op.drop_table('schedule_slots')
