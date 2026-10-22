"""Persisted revocations only enter through the authenticated cloud facade."""
import asyncio
import json
from uuid import uuid4

import pytest

from test_phone import h, Harness, signed
from test_phone_review import running, rpc, hello, closed_code
from foothold_agent.phone.hub import PhoneError
from foothold_agent.phone.observer import Observer
from foothold_agent.phone.tickets import Verifier, TicketError
from foothold_agent.safety.core import Z


def revocation(h, *, seq=1, jtis=None, sub=None, device=None, until=None):
    item = {'until': until or int(h.clock.wall())+600}
    if jtis is not None:
        item['jtis'] = jtis
    else:
        item['sub'] = sub
        if device is not None:
            item['device'] = device
    return {'t': 'phone.revoke', 'seq': seq, 'items': [item]}


@pytest.mark.parametrize('selector', ['jti','user','device'])
def test_cloud_revocation_stops_owner_closes_4403_and_rejects_new_hello(h, selector):
    from websockets.asyncio.client import connect
    async def run():
        async with running(h) as (server, uri, task):
            async with connect(uri,proxy=None) as ws:
                claims = await hello(h,ws)
                assert (await rpc(h,ws,'lease.take'))['ok']
                peer = h.hub.owner
                h.unlock(peer); h.cmd(peer,0); h.cmd(peer)
                assert h.hub.session.core.out == (.6,0,0)
                # Mint another unused token before revocation; JTI selection targets
                # both, while subject selectors also block future issuance.
                other = h.claims(user=claims['sub'],device=claims['device'])
                fields = ({'jtis':[claims['jti'],other['jti']]} if selector=='jti' else
                          {'sub':claims['sub'], **({'device':claims['device']} if selector=='device' else {})})
                frame = revocation(h,**fields)
                observer=Observer(h.hub); observer.connect()
                try:
                    effects=observer.receive(frame)
                    assert {'t':'phone.revoke.ack','seq':1} in effects.messages
                    assert h.hub.owner is None and h.hub.session.core.latch and h.hub.session.core.out == Z
                    assert h.outputs[-1].velocity == Z
                    assert await closed_code(ws) == 4403
                    async with connect(uri,proxy=None) as next_ws:
                        await next_ws.send(json.dumps(dict(t='hello',id='new',robot=h.robot,proto='fh-phone/1',
                            device=other['device'],ticket=signed(h.key,other))))
                        assert await closed_code(next_ws)==4403
                    assert not task.done() and server.failure is None
                finally:
                    observer._messages.close()
    asyncio.run(run())


def test_revocation_persists_restart_and_ack_is_idempotent(h,tmp_path):
    claims=h.claims()
    path=tmp_path/'revocation.sqlite'
    make=lambda: Verifier(h.robot,{'test':h.key},org=h.org,replay_path=str(path),clock_trusted=True,
                           wall=h.clock.wall,now=h.clock)
    frame=revocation(h,jtis=[claims['jti']])
    first=make(); first.revoke(frame); first.revoke(frame); first.close()
    second=make()
    try:
        with pytest.raises(TicketError):
            second.verify(signed(h.key,claims))
        assert second.db.execute('SELECT count(*) FROM revoked').fetchone()[0]==1
        # The same subject with an unrelated, unrevoked JTI remains usable.
        assert second.verify(signed(h.key,h.claims(user=claims['sub'],device=claims['device'])))
    finally:
        second.close()


def test_revocation_storage_failure_stops_and_denies_new_admission_without_ack(h):
    owner,_=h.moving()
    observer=Observer(h.hub); observer.connect()
    h.verifier.db.execute('PRAGMA query_only=ON')
    try:
        with pytest.raises(TicketError):
            observer.receive(revocation(h,sub=h.hub.peers[owner].user))
        assert h.verifier.revocation_failed and h.hub.owner is None
        assert h.hub.session.core.out==Z and h.hub.session.core.latch
        assert h.hub.closing[owner].close_code==4403
        with pytest.raises(PhoneError) as error:
            h.connect()
        assert error.value.close_code==4403
    finally:
        observer._messages.close()


def test_revocation_subject_device_scope_expiry_and_sequence_conflict(h):
    user,device=str(uuid4()),str(uuid4())
    frame=revocation(h,sub=user,device=device,until=int(h.clock.wall())+1)
    h.verifier.revoke(frame)
    for overrides in ({'user':user},{'device':device},{}):
        peer, _, _ = h.connect(**overrides)
        h.hub.disconnect(peer, reserve=False)
    with pytest.raises(PhoneError):
        h.connect(user=user,device=device)
    h.clock.t=1
    assert h.connect(user=user,device=device)
    with pytest.raises(TicketError):
        h.verifier.revoke({**frame,'seq':False})


def test_revocation_journal_capacity_and_conflicting_replay_fail_closed(h):
    frame=revocation(h,jtis=[str(uuid4())])
    h.verifier.revoke(frame)
    with pytest.raises(TicketError):
        h.verifier.revoke(revocation(h,seq=1,jtis=[str(uuid4())]))
    assert h.verifier.revocation_failed
    h.verifier.revocation_failed=False
    body=json.dumps(frame)
    for seq in range(2,4097):
        h.verifier.db.execute('INSERT INTO revoked VALUES (?,?,?)',(seq,body,int(h.clock.wall())+600))
    h.verifier.db.commit()
    with pytest.raises(TicketError):
        h.verifier.revoke(revocation(h,seq=4097,jtis=[str(uuid4())]))
    assert h.verifier.revocation_failed


def test_disconnected_cloud_facade_cannot_apply_revocation(h):
    owner,claims=h.moving()
    observer=Observer(h.hub)
    frame=revocation(h,jtis=[claims['jti']])
    try:
        effects=observer.receive(frame)
        assert not any(m['t']=='phone.revoke.ack' for m in effects.messages)
        assert h.hub.owner is owner and h.hub.session.core.out==(.6,0,0)
        assert h.verifier.db.execute('SELECT count(*) FROM revoked').fetchone()[0]==0
    finally:
        observer._messages.close()


@pytest.mark.parametrize('selector',['jti','user','device'])
@pytest.mark.parametrize('mono,offset',[(599,2),(599,1),(599.999,2),(600,2),(600.001,2)])
def test_open_revocation_uses_monotonic_authority_after_trusted_utc_forward(h,selector,mono,offset):
    owner,claims,_=h.connect(exp=int(h.clock.wall())+600)
    assert h.take(owner)['ok'];h.unlock(owner);h.cmd(owner,0);h.cmd(owner)
    observer=Observer(h.hub);observer.connect()
    try:
        # Preserve fresh ping/state and the original admission deadline.
        h.advance(min(mono,599.9))
        h.clock.t=mono;h.clock.offset=offset
        if mono<600:
            h.state(False);h.cmd(owner,0);h.cmd(owner)
            assert h.hub.session.core.out==(.6,0,0)
            assert h.hub.peers[owner].deadline==600
        fields=({'jtis':[claims['jti']]} if selector=='jti' else
                {'sub':claims['sub'],**({'device':claims['device']} if selector=='device' else {})})
        effects=observer.receive(revocation(h,until=claims['exp'],**fields))
        assert h.hub.owner is None and h.hub.session.core.latch and h.hub.session.core.out==Z
        assert owner not in h.hub.peers and h.hub.closing[owner].close_code==(4403 if mono<600 else 4401)
        assert {'t':'phone.revoke.ack','seq':1} in effects.messages
        # UTC expiry may omit cache storage; it must never omit open revocation.
        assert h.verifier.db.execute('SELECT count(*) FROM revoked').fetchone()[0]==0
        with pytest.raises(PhoneError):h.cmd(owner)
    finally:observer._messages.close()


@pytest.mark.parametrize('selector',['jti','user','device'])
def test_expired_revocation_does_not_close_normal_new_pass(h,selector):
    user,device=str(uuid4()),str(uuid4())
    until=int(h.clock.wall())
    peer,claims,_=h.connect(user=user,device=device)
    assert h.take(peer)['ok'];h.unlock(peer);h.cmd(peer,0);h.cmd(peer)
    fields=({'jtis':[str(uuid4())]} if selector=='jti' else
            {'sub':user,**({'device':device} if selector=='device' else {})})
    observer=Observer(h.hub);observer.connect()
    try:
        effects=observer.receive(revocation(h,until=until,**fields))
        assert h.hub.owner is peer and not h.hub.session.core.latch and h.hub.session.core.out==(.6,0,0)
        assert {'t':'phone.revoke.ack','seq':1} in effects.messages
    finally:observer._messages.close()


def test_large_journal_restart_preserves_revocations_used_ids_and_admission(tmp_path):
    h=Harness(replay_path=str(tmp_path/'large.sqlite'))
    initial=h.claims(exp=int(h.clock.wall())+600)
    token=signed(h.key,initial)
    assert h.verifier.verify(token)
    reopened=None
    try:
        for seq in range(1,1201):
            jtis=[str(uuid4()) for _ in range(51)]
            if seq==1:jtis[0]=initial['jti']
            frame=revocation(h,seq=seq,jtis=jtis)
            h.verifier.revoke(frame)
        pages=h.verifier.db.execute('PRAGMA page_count').fetchone()[0]
        assert 1024<pages<=2048
        h.verifier.close()
        try:
            reopened=Verifier(h.robot,{'test':h.key},org=h.org,replay_path=str(tmp_path/'large.sqlite'),
                clock_trusted=True,wall=h.clock.wall,now=h.clock)
        except ValueError as error:pytest.fail(f'valid enlarged journal rejected on restart: {error}')
        assert reopened.db.execute('SELECT count(*) FROM revoked').fetchone()[0]==1200
        assert reopened.db.execute('SELECT count(*) FROM used').fetchone()[0]==1
        with pytest.raises(TicketError):reopened.verify(token)
        reopened.revoke(frame)  # exact sequence/body replay stays idempotent
        assert reopened.db.execute('SELECT count(*) FROM revoked').fetchone()[0]==1200
        assert reopened.verify(signed(h.key,h.claims(exp=int(h.clock.wall())+600)))
        reopened.revoke(revocation(h,seq=1201,jtis=[str(uuid4())]))
        assert reopened.db.execute('SELECT count(*) FROM used').fetchone()[0]==2
        assert reopened.db.execute('SELECT count(*) FROM revoked').fetchone()[0]==1201
    finally:
        h.hub.close();h.verifier.close()
        if reopened is not None:reopened.close()
