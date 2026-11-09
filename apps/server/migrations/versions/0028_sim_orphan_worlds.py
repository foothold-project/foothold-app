"""Archive unused simulation floors whose world has left the server catalogue.

No hard deletes. The event journal and parent-first trash restore support selective
undo; downgrade intentionally retains the repaired data and all scenarios.
"""
import json

from alembic import op
from sqlalchemy.orm import Session

from apps.server.fh_server.sim_maps import archive_removed_worlds, supported_world_ids

revision = '0028'
down_revision = '0027'
branch_labels = None
depends_on = None


def upgrade():
    world_ids = supported_world_ids()
    with Session(bind=op.get_bind()) as db:
        logs = archive_removed_worlds(db, world_ids, migration='0028')
    for entry in logs:
        print('SIM_PAIR_0028 ' + json.dumps(entry, ensure_ascii=False, sort_keys=True))
    print('SIM_PAIR_0028 in_use_floors_preserved=' + str(sum(
        entry['reason'] == 'in_use_preserved' for entry in logs)))


def downgrade():
    print('SIM_PAIR_0028 downgrade retains data; selective undo: events.code=SIM_PAIR_REPAIRED, '
          'data.migration=0028; restore parents before floors in trash')
