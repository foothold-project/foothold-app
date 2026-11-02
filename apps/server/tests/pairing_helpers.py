"""Register synthetic wire-test robots through the operator-only pairing flow."""


async def paired_async(http, auth, *, prefix='/api/v1', name='wire-robot', serial='2345-6789'):
    response = await http.post(prefix + '/pairing/start', json={
        'model': 'unitree_go2', 'robot_serial': serial})
    assert response.status_code == 200, response.text
    pending = response.json()
    response = await http.post(prefix + '/pairing/claim', headers=auth, json={'code': pending['code']})
    assert response.status_code == 200, response.text
    path = prefix + '/pairing/' + pending['pairing_id']
    response = await http.post(path + '/confirm', headers=auth, json={'name': name})
    assert response.status_code == 200, response.text
    robot = response.json()
    response = await http.post(path + '/poll', json={'poll_secret': pending['poll_secret']})
    assert response.status_code == 200, response.text
    return {'robot': robot, 'agent_token': response.json()['agent_token']}
