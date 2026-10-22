"""Server reservation boundaries checked against the actual file SQLite journal."""
import json
import time
from types import SimpleNamespace
from uuid import UUID, uuid4
import hmac

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session as DBSession

from .test_phone_pass import pc, issue, b64, Verifier, TicketError
from apps.server.fh_server.models import PhoneRevocationBatch
from apps.server.fh_server.phone_pass import pack, reserved_usage


@pytest.mark.parametrize('shape,chunk',[('maximum',102),('over_half_page',51),('single',1)])
def test_server_last_admitted_state_fits_real_agent_journal(pc,seeded,tmp_path,shape,chunk):
    current=int(time.time());pc.app.state.phone_pass_issuer.clock=lambda:current
    rid=str(seeded['robots']['mine']);until=current+600
    frames=[];used=[];total=0
    # Each prior issuance can reserve 1 row/4 KiB; its subsequent packed
    # revocation cannot exceed that. Stop at the last admissible issuance.
    while len(frames)<4096 and total+4096<=1024*1024:
        records=[SimpleNamespace(jti=uuid4(),exp=until) for _ in range(chunk)]
        packed=list(pack(records))
        assert len(packed)==1
        items,members=packed[0]
        frame=dict(t='phone.revoke',seq=len(frames)+1,items=items)
        size=len(json.dumps(frame,sort_keys=True,separators=(',',':')).encode())
        assert size<=4096
        if shape=='maximum':assert size>=4000
        if shape=='over_half_page':assert 2048<size<2100
        used.extend(str(row.jti) for row in members if len(used)<4096)
        frames.append(frame);total+=size
    assert len(used)>=4096
    used=used[:4096]
    engine=create_engine(seeded['urls']['app'])
    verifier=Verifier(rid,pc.keys[rid][1],org=str(seeded['org']),replay_path=str(tmp_path/'capacity.sqlite'),
        clock_trusted=True,wall=lambda:current,now=lambda:0)
    try:
        with DBSession(engine) as db:
            db.add_all([PhoneRevocationBatch(id=f['seq'],org_id=seeded['org'],robot_id=UUID(rid),
                items=f['items'],until=until) for f in frames]);db.commit()
            assert reserved_usage(db,seeded['org'],UUID(rid),current)==(len(frames),total)
        response=issue(pc,seeded,purpose='view')
        assert response.status_code==503 and response.json()['error']['code']=='PASS_REVOCATION_CAPACITY'
        # Fill the shared spent-ID table through real signature validation,
        # before revoking these IDs. No raw INSERT shortcuts in the agent DB.
        key=pc.keys[rid][1]['test']
        header=b64(json.dumps(dict(alg='HS256',typ='JWT',kid='test')).encode())
        for nonce in used:
            claims=dict(iss='fh-control',aud='fh-phone/1',org=str(seeded['org']),robot=rid,
                sub=str(uuid4()),device=str(uuid4()),purpose='view',iat=current,exp=until,jti=nonce)
            signed=header+'.'+b64(json.dumps(claims).encode())
            verifier.verify(signed+'.'+b64(hmac.digest(key,signed.encode(),'sha256')))
        assert verifier.db.execute('SELECT count(*) FROM used').fetchone()[0]==4096
        for frame in frames:
            try:verifier.revoke(frame)
            except TicketError as error:pytest.fail(f'{shape}: server-admitted journal failed: {error}')
        assert verifier.db.execute('SELECT count(*) FROM revoked').fetchone()[0]==len(frames)
        pages=verifier.db.execute('PRAGMA page_count').fetchone()[0]
        assert pages<=2048
        print('JOURNAL_CAPACITY',shape,'rows',len(frames),'wire',total,'used',len(used),'pages',pages)
    finally:verifier.close();engine.dispose()
