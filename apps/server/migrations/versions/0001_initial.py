"""Initial server-owned tables and least-privilege grants (FH-SPEC-06)."""
from alembic import op

revision = '0001'
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.execute(r'''
CREATE TABLE organizations (
	id UUID DEFAULT gen_random_uuid() NOT NULL,
	name TEXT NOT NULL,
	settings JSONB DEFAULT '{}'::jsonb NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (id)
);

CREATE TABLE users (
	id UUID DEFAULT gen_random_uuid() NOT NULL,
	username TEXT NOT NULL,
	display_name TEXT NOT NULL,
	role TEXT NOT NULL,
	password_hash TEXT NOT NULL,
	locked BOOLEAN DEFAULT false NOT NULL,
	notify_prefs JSONB DEFAULT '{}'::jsonb NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	archived_at TIMESTAMP WITH TIME ZONE,
	org_id UUID NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(org_id) REFERENCES organizations (id),
	UNIQUE (org_id, id),
	CONSTRAINT user_role CHECK (role IN ('ORG_ADMIN','OPERATOR'))
);

CREATE UNIQUE INDEX users_org_username ON users (org_id, lower(username));

CREATE TABLE robots (
	id UUID DEFAULT gen_random_uuid() NOT NULL,
	name TEXT NOT NULL,
	model TEXT NOT NULL,
	owner_user_id UUID,
	agent_token_hash BYTEA NOT NULL,
	last_floor_id UUID,
	last_floor_source TEXT,
	last_seen_at TIMESTAMP WITH TIME ZONE,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	archived_at TIMESTAMP WITH TIME ZONE,
	org_id UUID NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(org_id) REFERENCES organizations (id),
	FOREIGN KEY(org_id, owner_user_id) REFERENCES users (org_id, id),
	UNIQUE (org_id, name),
	UNIQUE (org_id, id),
	CONSTRAINT floor_source CHECK (last_floor_source IN ('HUMAN','AUTO'))
);

CREATE TABLE sessions (
	id UUID DEFAULT gen_random_uuid() NOT NULL,
	user_id UUID NOT NULL,
	token_hash BYTEA NOT NULL,
	client TEXT NOT NULL,
	device_label TEXT NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
	revoked_at TIMESTAMP WITH TIME ZONE,
	refresh_hash BYTEA,
	refresh_expires_at TIMESTAMP WITH TIME ZONE,
	csrf_hash BYTEA,
	org_id UUID NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(org_id, user_id) REFERENCES users (org_id, id),
	CONSTRAINT session_client CHECK (client IN ('web','app')),
	UNIQUE (token_hash),
	UNIQUE (refresh_hash)
);

CREATE TABLE events (
	id BIGSERIAL NOT NULL,
	at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	robot_at TIMESTAMP WITH TIME ZONE,
	category TEXT NOT NULL,
	code TEXT NOT NULL,
	severity TEXT NOT NULL,
	message TEXT NOT NULL,
	robot_id UUID,
	user_id UUID,
	run_id UUID,
	approval_id UUID,
	data JSONB DEFAULT '{}'::jsonb NOT NULL,
	org_id UUID NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(org_id) REFERENCES organizations (id),
	FOREIGN KEY(org_id, robot_id) REFERENCES robots (org_id, id),
	FOREIGN KEY(org_id, user_id) REFERENCES users (org_id, id),
	CONSTRAINT event_category CHECK (category IN ('RUN','ROUTE','LINK','LEASE','APPROVAL','SAFETY','ACCOUNT')),
	CONSTRAINT event_severity CHECK (severity IN ('INFO','WARN','ERROR'))
);

CREATE INDEX events_category_at ON events (category, at DESC);

CREATE INDEX events_org_at ON events (org_id, at DESC);

CREATE INDEX events_robot_at ON events (robot_id, at DESC);

CREATE INDEX events_run_at ON events (run_id, at);
GRANT USAGE ON SCHEMA public TO fh_app, fh_readonly;
GRANT SELECT, INSERT, UPDATE ON organizations, users, sessions, robots TO fh_app;
GRANT SELECT, INSERT ON events TO fh_app;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON events FROM fh_app;
GRANT USAGE, SELECT ON SEQUENCE events_id_seq TO fh_app;
GRANT SELECT ON organizations, users, sessions, robots, events TO fh_readonly;
GRANT SELECT ON SEQUENCE events_id_seq TO fh_readonly;
''')


def downgrade():
    for name in ('events', 'sessions', 'robots', 'users', 'organizations'):
        op.drop_table(name)
