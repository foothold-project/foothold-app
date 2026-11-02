"""Nullable history references and a narrow, transactional trash purge capability."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = '0023'
down_revision = '0022'
branch_labels = None
depends_on = None


def upgrade():
    for table, columns in {'runs': ('scenario_name_snapshot', 'floor_name_snapshot'),
                           'assignments': ('scenario_name_snapshot',),
                           'approvals': ('floor_name_snapshot',)}.items():
        for column in columns:
            op.add_column(table, sa.Column(column, sa.Text(), nullable=True))
    for table, columns in {'runs': ('scenario_version_id', 'floor_id', 'map_version_id'),
                           'assignments': ('scenario_version_id',), 'approvals': ('target_id',)}.items():
        for column in columns:
            op.alter_column(table, column, nullable=True)
    op.create_table('file_deletions',
        sa.Column('id', UUID(), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('org_id', UUID(), nullable=False),
        sa.Column('path', sa.Text(), nullable=False),
        sa.Column('attempts', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id']))
    op.execute('GRANT SELECT, UPDATE, DELETE ON file_deletions TO fh_app')
    op.execute('GRANT SELECT ON file_deletions TO fh_readonly')
    # No table-wide DELETE grants on immutable resources or broad UPDATE on
    # history. The definer owns only the same schema as the migration role;
    # fixed search_path, no dynamic SQL, PUBLIC execute explicitly revoked.
    op.execute(r"""
CREATE FUNCTION fh_purge_resource(p_org uuid, p_kind text, p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE resource_name text; upload_ids uuid[]; upload_paths text[];
BEGIN
    IF p_kind = 'scenario' THEN
        SELECT name INTO resource_name FROM public.scenarios
          WHERE org_id=p_org AND id=p_id AND archived_at IS NOT NULL FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Resource must be in trash'; END IF;
        IF EXISTS (SELECT 1 FROM public.runs WHERE org_id=p_org
            AND status NOT IN ('COMPLETED','FAILED','CANCELED','ABORTED')
            AND scenario_version_id IN (SELECT id FROM public.scenario_versions WHERE org_id=p_org AND scenario_id=p_id))
          OR EXISTS (SELECT 1 FROM public.assignments WHERE org_id=p_org AND status IN ('ACTIVE','PENDING')
            AND scenario_version_id IN (SELECT id FROM public.scenario_versions WHERE org_id=p_org AND scenario_id=p_id))
          OR EXISTS (SELECT 1 FROM public.approvals a JOIN public.assignments t
            ON t.org_id=a.org_id AND t.id=a.target_id AND a.target_type='assignment'
            JOIN public.scenario_versions v ON v.org_id=t.org_id AND v.id=t.scenario_version_id
            WHERE a.org_id=p_org AND a.status='PENDING' AND v.scenario_id=p_id)
          THEN RAISE EXCEPTION 'Resource in use'; END IF;
        UPDATE public.runs r SET scenario_name_snapshot=v.name, scenario_version_id=NULL
          FROM public.scenario_versions v WHERE r.org_id=p_org AND v.org_id=p_org
          AND r.scenario_version_id=v.id AND v.scenario_id=p_id;
        UPDATE public.assignments a SET scenario_name_snapshot=v.name, scenario_version_id=NULL
          FROM public.scenario_versions v WHERE a.org_id=p_org AND v.org_id=p_org
          AND a.scenario_version_id=v.id AND v.scenario_id=p_id;
        DELETE FROM public.agent_plan_maps WHERE org_id=p_org AND scenario_version_id IN
          (SELECT id FROM public.scenario_versions WHERE org_id=p_org AND scenario_id=p_id);
        DELETE FROM public.scenario_versions WHERE org_id=p_org AND scenario_id=p_id;
        DELETE FROM public.scenarios WHERE org_id=p_org AND id=p_id;
    ELSIF p_kind = 'floor' THEN
        SELECT name INTO resource_name FROM public.floors
          WHERE org_id=p_org AND id=p_id AND archived_at IS NOT NULL FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Resource must be in trash'; END IF;
        IF EXISTS (SELECT 1 FROM public.scenario_versions WHERE org_id=p_org AND p_id=ANY(floor_ids))
          OR EXISTS (SELECT 1 FROM public.runs WHERE org_id=p_org AND floor_id=p_id
            AND status NOT IN ('COMPLETED','FAILED','CANCELED','ABORTED'))
          OR EXISTS (SELECT 1 FROM public.robots WHERE org_id=p_org AND archived_at IS NULL AND last_floor_id=p_id)
          OR EXISTS (SELECT 1 FROM public.robots r JOIN public.floors f ON f.id=p_id AND f.org_id=p_org
            JOIN public.buildings b ON b.org_id=p_org AND b.id=f.building_id
            WHERE r.org_id=p_org AND r.archived_at IS NULL AND r.simulation AND r.sim_state != 'IDLE'
            AND b.sim_world_id IS NOT NULL AND (r.sim_world_id IS NULL OR r.sim_world_id=b.sim_world_id))
          OR EXISTS (SELECT 1 FROM public.approvals WHERE org_id=p_org AND status='PENDING'
            AND (target_id IN (SELECT id FROM public.map_versions WHERE org_id=p_org AND floor_id=p_id)
              OR base_ref_id IN (SELECT id FROM public.map_versions WHERE org_id=p_org AND floor_id=p_id)))
          THEN RAISE EXCEPTION 'Resource in use'; END IF;
        UPDATE public.runs SET floor_name_snapshot=resource_name, floor_id=NULL
          WHERE org_id=p_org AND floor_id=p_id;
        UPDATE public.runs SET map_version_id=NULL WHERE org_id=p_org AND map_version_id IN
          (SELECT id FROM public.map_versions WHERE org_id=p_org AND floor_id=p_id);
        UPDATE public.robots SET last_floor_id=NULL WHERE org_id=p_org AND last_floor_id=p_id;
        UPDATE public.approvals SET floor_name_snapshot=resource_name, target_id=NULL
          WHERE org_id=p_org AND target_type='map_version' AND target_id IN
          (SELECT id FROM public.map_versions WHERE org_id=p_org AND floor_id=p_id);
        UPDATE public.approvals SET base_ref_id=NULL, base_ref_type=NULL WHERE org_id=p_org AND base_ref_id IN
          (SELECT id FROM public.map_versions WHERE org_id=p_org AND floor_id=p_id);
        DELETE FROM public.agent_plan_maps WHERE org_id=p_org AND map_version_id IN
          (SELECT id FROM public.map_versions WHERE org_id=p_org AND floor_id=p_id);
        DELETE FROM public.floor_connectors WHERE org_id=p_org AND (floor_a_id=p_id OR floor_b_id=p_id);
        UPDATE public.floors SET approved_version_id=NULL WHERE org_id=p_org AND id=p_id;
        SELECT array_agg(DISTINCT upload_id) INTO upload_ids FROM public.map_versions WHERE org_id=p_org AND floor_id=p_id;
        INSERT INTO public.file_deletions(org_id,path)
          SELECT p_org, image_path FROM public.map_versions WHERE org_id=p_org AND floor_id=p_id
          UNION SELECT p_org, regexp_replace(image_path, '\.png$', '.yaml')
          FROM public.map_versions WHERE org_id=p_org AND floor_id=p_id;
        DELETE FROM public.map_versions WHERE org_id=p_org AND floor_id=p_id;
        -- Uploads may share their generated image path (YAML metadata copy).
        -- Lock candidates before checking references and delete only unshared
        -- rows; FK insertion serializes any concurrent reuse of their IDs.
        PERFORM id FROM public.uploads WHERE org_id=p_org AND image_path IN
          (SELECT image_path FROM public.uploads WHERE org_id=p_org AND id=ANY(upload_ids)) ORDER BY id FOR UPDATE;
        WITH removed AS (
          DELETE FROM public.uploads u WHERE u.org_id=p_org AND u.image_path IN
            (SELECT image_path FROM public.uploads WHERE org_id=p_org AND id=ANY(upload_ids))
            AND NOT EXISTS (SELECT 1 FROM public.map_versions v WHERE v.org_id=p_org AND v.upload_id=u.id)
          RETURNING image_path
        ) SELECT array_agg(DISTINCT image_path) INTO upload_paths FROM removed;
        INSERT INTO public.file_deletions(org_id,path) SELECT p_org, path FROM unnest(upload_paths) path
          WHERE NOT EXISTS (SELECT 1 FROM public.uploads WHERE image_path=path);
        DELETE FROM public.floors WHERE org_id=p_org AND id=p_id;
    ELSE
        RAISE EXCEPTION 'Unsupported resource kind';
    END IF;
END $$
""")
    op.execute('REVOKE ALL ON FUNCTION fh_purge_resource(uuid,text,uuid) FROM PUBLIC')
    op.execute('GRANT EXECUTE ON FUNCTION fh_purge_resource(uuid,text,uuid) TO fh_app')


def downgrade():
    # After a purge, old NOT NULL contracts cannot represent retained history.
    # Never delete that history just to make a schema downgrade pass.
    op.execute("""DO $$ BEGIN IF EXISTS (SELECT 1 FROM runs WHERE scenario_version_id IS NULL OR floor_id IS NULL OR map_version_id IS NULL)
      OR EXISTS (SELECT 1 FROM assignments WHERE scenario_version_id IS NULL)
      OR EXISTS (SELECT 1 FROM approvals WHERE target_id IS NULL)
      OR EXISTS (SELECT 1 FROM file_deletions) THEN
        RAISE EXCEPTION 'Reconcile purged history and pending file deletions before downgrade';
      END IF; END $$""")
    op.execute('DROP FUNCTION fh_purge_resource(uuid,text,uuid)')
    op.drop_table('file_deletions')
    for table, columns in {'runs': ('scenario_version_id', 'floor_id', 'map_version_id'),
                           'assignments': ('scenario_version_id',), 'approvals': ('target_id',)}.items():
        for column in columns:
            op.alter_column(table, column, nullable=False)
    for table, columns in {'runs': ('scenario_name_snapshot', 'floor_name_snapshot'),
                           'assignments': ('scenario_name_snapshot',), 'approvals': ('floor_name_snapshot',)}.items():
        for column in columns:
            op.drop_column(table, column)
