"""Remove old materialized sim defaults only when never explicitly saved."""
from alembic import op
import sqlalchemy as sa

revision = '0024'
down_revision = '0023'
branch_labels = None
depends_on = None


def upgrade():
    # ORG_SETTINGS_UPDATED.data contains exactly the PATCH fields. An old
    # default with no mention in this organization's history was filled by
    # model_dump(), not chosen by the user. Other values/history stay intact.
    for setting, old_value in (('sim_max_vx', '1.0'), ('sim_max_vy', '0.3'),
                               ('sim_max_wz', '0.5'), ('sim_key_vx', '0.6')):
        op.execute(sa.text("""
            UPDATE organizations AS o
            SET settings = o.settings - :setting
            WHERE o.settings -> :setting = CAST(:old_value AS jsonb)
              AND NOT EXISTS (
                SELECT 1 FROM events AS e
                WHERE e.org_id = o.id AND e.code = 'ORG_SETTINGS_UPDATED'
                  AND e.data ? :setting
              )
        """).bindparams(setting=setting, old_value=old_value))


def downgrade():
    # We cannot reconstruct which absent keys used to be implicit defaults.
    # Restoring them would pin defaults again or overwrite later user choices.
    pass
