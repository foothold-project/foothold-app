"""정비 일정 칸 · 칸 표시 이름 · 로봇 장비 등급 (11/28 15:04).

MAINTENANCE 칸은 BATTERY_SWAP 처럼 시나리오 없이 만든다. busy_label 은 가용 표시 이름 (1~64 자).
equipment_tier 는 총괄이 정하는 로봇 속성 (STANDARD · UPPER · null). fh_app 은 두 표에 이미 UPDATE 권한이 있다.
"""
from alembic import op
import sqlalchemy as sa

revision = '0040'
down_revision = '0039'  # local integration: chain after 0039_robot_demo
branch_labels = None
depends_on = None


def upgrade():
    op.drop_constraint('schedule_slot_kind', 'schedule_slots', type_='check')
    op.create_check_constraint('schedule_slot_kind', 'schedule_slots', "kind IN ('CONFIRMED','DRAFT','BATTERY_SWAP','MAINTENANCE')")
    op.drop_constraint('schedule_slot_scenario_required', 'schedule_slots', type_='check')
    op.create_check_constraint('schedule_slot_scenario_required', 'schedule_slots',
                               "scenario_id IS NOT NULL OR kind IN ('BATTERY_SWAP','MAINTENANCE')")
    op.add_column('schedule_slots', sa.Column('busy_label', sa.Text(), nullable=True))
    op.create_check_constraint('schedule_slot_busy_label', 'schedule_slots',
                               'busy_label IS NULL OR char_length(busy_label) BETWEEN 1 AND 64')
    op.add_column('robots', sa.Column('equipment_tier', sa.Text(), nullable=True))
    op.create_check_constraint('robot_equipment_tier', 'robots', "equipment_tier IS NULL OR equipment_tier IN ('STANDARD','UPPER')")


def downgrade():
    op.drop_constraint('robot_equipment_tier', 'robots', type_='check')
    op.drop_column('robots', 'equipment_tier')
    op.drop_constraint('schedule_slot_busy_label', 'schedule_slots', type_='check')
    op.drop_column('schedule_slots', 'busy_label')
    op.execute("DELETE FROM schedule_slots WHERE kind = 'MAINTENANCE'")
    op.drop_constraint('schedule_slot_scenario_required', 'schedule_slots', type_='check')
    op.create_check_constraint('schedule_slot_scenario_required', 'schedule_slots', "scenario_id IS NOT NULL OR kind = 'BATTERY_SWAP'")
    op.drop_constraint('schedule_slot_kind', 'schedule_slots', type_='check')
    op.create_check_constraint('schedule_slot_kind', 'schedule_slots', "kind IN ('CONFIRMED','DRAFT','BATTERY_SWAP')")
