"""일정 칸 예약 실행 상태 (11/28). 칸 하나는 한 번만 시작된다: run_state 가 비어 있을 때만 잡고, run_id 는 유일.

confirmed_by: 칸을 CONFIRMED 로 만든 사람 (그 사람 권한으로 잠금 해제를 미리 누른 것으로 본다, 시뮬만).
이미 있던 확정 칸은 비워 둔다 (누가 확정했는지 모름 -> 예약 실행은 SKIPPED CONFIRMER_NOT_ALLOWED).
"""
from alembic import op

revision = '0037'
down_revision = '0036'
branch_labels = None
depends_on = None


def upgrade():
    op.execute('''ALTER TABLE schedule_slots
        ADD COLUMN run_state TEXT, ADD COLUMN run_id UUID, ADD COLUMN run_code TEXT, ADD COLUMN run_at TIMESTAMPTZ,
        ADD COLUMN confirmed_by UUID,
        ADD CONSTRAINT schedule_slot_run_state CHECK (run_state IS NULL OR run_state IN
            ('STARTING','STARTED','DONE','FAILED','SKIPPED','MISSED')),
        ADD CONSTRAINT schedule_slot_run_pair CHECK ((run_state IS NULL) = (run_at IS NULL)),
        ADD CONSTRAINT schedule_slot_run_id UNIQUE (run_id)''')
    op.execute('CREATE INDEX schedule_slots_due ON schedule_slots(org_id, start_at) WHERE run_state IS NULL')


def downgrade():
    op.execute('DROP INDEX schedule_slots_due')
    op.execute('''ALTER TABLE schedule_slots DROP CONSTRAINT schedule_slot_run_id,
        DROP CONSTRAINT schedule_slot_run_pair, DROP CONSTRAINT schedule_slot_run_state,
        DROP COLUMN confirmed_by, DROP COLUMN run_at, DROP COLUMN run_code, DROP COLUMN run_id, DROP COLUMN run_state''')
