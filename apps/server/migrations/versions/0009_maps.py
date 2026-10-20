"""S3a tenant-bound maps; map snapshots grant INSERT/SELECT only."""
from alembic import op

revision = '0009'
down_revision = '0008'
branch_labels = None
depends_on = None


def upgrade():
    op.execute('''CREATE TABLE sites (
	id UUID DEFAULT gen_random_uuid() NOT NULL,
	name TEXT NOT NULL,
	org_id UUID NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(org_id) REFERENCES organizations (id),
	UNIQUE (org_id, id)
)''')
    op.execute('''CREATE TABLE buildings (
	id UUID DEFAULT gen_random_uuid() NOT NULL,
	site_id UUID NOT NULL,
	name TEXT NOT NULL,
	org_id UUID NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(org_id, site_id) REFERENCES sites (org_id, id),
	UNIQUE (org_id, id)
)''')
    op.execute('''CREATE TABLE floors (
	id UUID DEFAULT gen_random_uuid() NOT NULL,
	building_id UUID NOT NULL,
	name TEXT NOT NULL,
	level INTEGER NOT NULL,
	approved_version_id UUID,
	org_id UUID NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(org_id, building_id) REFERENCES buildings (org_id, id),
	UNIQUE (org_id, id)
)''')
    op.execute('''CREATE TABLE uploads (
	id UUID DEFAULT gen_random_uuid() NOT NULL,
	image_path TEXT NOT NULL,
	image_sha256 BYTEA NOT NULL,
	png_sha256 BYTEA NOT NULL,
	size_bytes INTEGER NOT NULL,
	width INTEGER NOT NULL,
	height INTEGER NOT NULL,
	metadata_json JSONB NOT NULL,
	created_by UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	org_id UUID NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(org_id, created_by) REFERENCES users (org_id, id),
	UNIQUE (org_id, id)
)''')
    op.execute('''CREATE TABLE map_versions (
	id UUID DEFAULT gen_random_uuid() NOT NULL,
	floor_id UUID NOT NULL,
	number INTEGER NOT NULL,
	base_version_id UUID,
	copied_from_id UUID,
	upload_id UUID NOT NULL,
	status TEXT NOT NULL,
	image_path TEXT NOT NULL,
	image_sha256 BYTEA NOT NULL,
	width INTEGER NOT NULL,
	height INTEGER NOT NULL,
	resolution FLOAT NOT NULL,
	origin_x FLOAT NOT NULL,
	origin_y FLOAT NOT NULL,
	origin_yaw FLOAT NOT NULL,
	features JSONB NOT NULL,
	reason TEXT NOT NULL,
	source TEXT NOT NULL,
	created_by UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	org_id UUID NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(org_id, floor_id) REFERENCES floors (org_id, id),
	FOREIGN KEY(org_id, floor_id, base_version_id) REFERENCES map_versions (org_id, floor_id, id),
	FOREIGN KEY(org_id, upload_id) REFERENCES uploads (org_id, id),
	FOREIGN KEY(org_id, created_by) REFERENCES users (org_id, id),
	UNIQUE (org_id, floor_id, id),
	UNIQUE (org_id, id),
	UNIQUE (floor_id, number),
	CONSTRAINT map_version_status CHECK (status IN ('PENDING','APPROVED','REJECTED','SUPERSEDED')),
	CONSTRAINT map_version_source CHECK (source IN ('SLAM','EDIT','ROLLBACK','IMPORT'))
)''')
    op.execute('''CREATE TABLE floor_connectors (
	id UUID NOT NULL,
	building_id UUID NOT NULL,
	kind TEXT NOT NULL,
	floor_a_id UUID NOT NULL,
	floor_b_id UUID NOT NULL,
	a_pose JSONB NOT NULL,
	b_pose JSONB,
	map_version_a_id UUID NOT NULL,
	map_version_b_id UUID,
	active BOOLEAN NOT NULL,
	org_id UUID NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(org_id, building_id) REFERENCES buildings (org_id, id),
	FOREIGN KEY(org_id, floor_a_id, map_version_a_id) REFERENCES map_versions (org_id, floor_id, id),
	FOREIGN KEY(org_id, floor_b_id) REFERENCES floors (org_id, id),
	FOREIGN KEY(org_id, floor_b_id, map_version_b_id) REFERENCES map_versions (org_id, floor_id, id),
	CONSTRAINT connector_kind CHECK (kind IN ('STAIRS','ELEVATOR'))
)''')
    op.execute('''ALTER TABLE floors ADD CONSTRAINT floors_approved_version_fk FOREIGN KEY(org_id, id, approved_version_id) REFERENCES map_versions (org_id, floor_id, id)''')
    op.execute('''ALTER TABLE robots ADD CONSTRAINT robots_last_floor_fk FOREIGN KEY(org_id, last_floor_id) REFERENCES floors (org_id, id)''')
    op.execute('GRANT SELECT, INSERT, UPDATE, DELETE ON sites, buildings, floors, floor_connectors TO fh_app')
    op.execute('GRANT SELECT, INSERT ON uploads, map_versions TO fh_app')
    op.execute('GRANT SELECT ON sites, buildings, floors, uploads, map_versions, floor_connectors TO fh_readonly')


def downgrade():
    op.drop_constraint('robots_last_floor_fk', 'robots', type_='foreignkey')
    op.drop_constraint('floors_approved_version_fk', 'floors', type_='foreignkey')
    for name in ('floor_connectors', 'map_versions', 'uploads', 'floors', 'buildings', 'sites'):
        op.drop_table(name)
