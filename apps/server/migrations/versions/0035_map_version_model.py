"""Optional indoor 3D model (GLB) per map version; display only.

map_versions stays insert-only except status and these two columns, so a model
can be attached to an already approved image version by the sim-world sync.
"""
from alembic import op
import sqlalchemy as sa

revision = '0035'
down_revision = '0034'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('map_versions', sa.Column('model_path', sa.Text(), nullable=True))
    op.add_column('map_versions', sa.Column('model_sha256', sa.LargeBinary(), nullable=True))
    op.create_check_constraint('map_version_model', 'map_versions',
        '(model_path IS NULL) = (model_sha256 IS NULL) AND (model_sha256 IS NULL OR length(model_sha256) = 32)')
    op.execute('GRANT UPDATE (model_path, model_sha256) ON map_versions TO fh_app')


def downgrade():
    op.execute('REVOKE UPDATE (model_path, model_sha256) ON map_versions FROM fh_app')
    op.drop_constraint('map_version_model', 'map_versions', type_='check')
    op.drop_column('map_versions', 'model_sha256')
    op.drop_column('map_versions', 'model_path')
