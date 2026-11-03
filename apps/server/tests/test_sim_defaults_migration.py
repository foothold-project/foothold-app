"""Real PostgreSQL upgrade/downgrade: inherited versus chosen sim defaults."""
import json

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text

from apps.contracts.models import OrgSettings
from .conftest import CONFIG
from .postgres import temporary_postgres


def test_sim_defaults_upgrade_uses_org_scoped_field_history_and_downgrade_is_noop(monkeypatch):
    old = dict(sim_max_vx=1.0, sim_max_vy=.3, sim_max_wz=.5, sim_key_vx=.6)
    unrelated = dict(battery_low_pct=25, real_no_fast_server_drive=True)
    custom = dict(sim_max_vx=1.2, sim_max_vy=.2, sim_max_wz=.4, sim_key_vx=.7)
    with temporary_postgres() as urls:
        monkeypatch.setenv('FH_MIGRATE_DATABASE_URL', urls['migrate'])
        config, engine = Config(str(CONFIG)), create_engine(urls['migrate'])
        try:
            command.upgrade(config, '0023')
            with engine.begin() as conn:
                def org(name, settings):
                    return conn.scalar(text("""INSERT INTO organizations(name, settings)
                        VALUES (:name, CAST(:settings AS jsonb)) RETURNING id"""),
                        {'name': name, 'settings': json.dumps(settings)})

                def history(org_id, values, code='ORG_SETTINGS_UPDATED'):
                    conn.execute(text("""INSERT INTO events(org_id,category,code,severity,message,data)
                        VALUES (:org,'ACCOUNT',:code,'INFO','synthetic settings history',CAST(:data AS jsonb))"""),
                        {'org': org_id, 'code': code, 'data': json.dumps(values)})

                inherited = org('materialized defaults', {**old, **unrelated})
                chosen = org('explicit defaults', {**old, **unrelated})
                forward_only = org('explicit forward only', old)
                different = org('nondefault values without history', custom)
                absent = org('absent fields', unrelated)
                wrong_type = org('string is not a numeric default', {'sim_max_vy': '0.3'})
                history(inherited, {'battery_low_pct': 25})
                history(inherited, old, code='OTHER_EVENT')  # Wrong code must not pin fields.
                history(chosen, {'sim_max_vy': .2})  # Any earlier mention preserves a field.
                history(chosen, {k: v for k, v in old.items() if k != 'sim_max_vy'})
                history(forward_only, {'sim_max_vx': 1.0})
                before_events = conn.execute(text('SELECT org_id,code,data FROM events ORDER BY id')).all()

            def snapshots():
                with engine.connect() as conn:
                    return dict(conn.execute(text('SELECT id,settings FROM organizations')).all())

            command.upgrade(config, '0024')
            after = snapshots()
            assert after[inherited] == unrelated
            assert after[chosen] == {**old, **unrelated}
            assert after[forward_only] == {'sim_max_vx': 1.0}
            assert after[different] == custom and after[absent] == unrelated
            assert after[wrong_type] == {'sim_max_vy': '0.3'}
            restored = OrgSettings.model_validate(after[inherited])
            assert [restored.sim_max_vx, restored.sim_max_vy, restored.sim_max_wz, restored.sim_key_vx] == [1.5, .5, 1.2, 1.5]
            assert OrgSettings.model_validate(after[chosen]).sim_max_vy == .3
            assert OrgSettings.model_validate(after[forward_only]).sim_key_vx == 1.0
            with engine.connect() as conn:
                assert conn.execute(text('SELECT org_id,code,data FROM events ORDER BY id')).all() == before_events
            command.downgrade(config, '0023')
            assert snapshots() == after
            # A choice made after downgrade must also survive another upgrade.
            with engine.begin() as conn:
                conn.execute(text('UPDATE organizations SET settings=settings || CAST(:choice AS jsonb) WHERE id=:id'),
                             {'choice': json.dumps({'sim_max_vy': .3}), 'id': inherited})
                history(inherited, {'sim_max_vy': .3})
            command.upgrade(config, '0024')
            assert snapshots() == {**after, inherited: {**unrelated, 'sim_max_vy': .3}}
        finally:
            engine.dispose()
