"""Run a supplied adapted config against disposable loopback HTTP fixtures only.

Usage: FH_TEST_PORT_RANGE=19780:19799 FH_TEST_STORAGE=/tmp/fh-caddy-example \
       python3 -B caddy_boundary.py < adapted.json
No TLS, admin API, production listeners, credentials or service changes.
Only caller-created disposable storage is used; config persistence is disabled.
Set FH_TEST_STORAGE to a fresh /tmp directory and remove that literal directory
after the process exits; the script refuses pre-existing storage.
"""
import http.client
import json
import os
import socket
import subprocess
import sys
import threading
from types import SimpleNamespace
import time
from http.server import BaseHTTPRequestHandler, HTTPServer


def main():
    first,last=map(int,os.environ['FH_TEST_PORT_RANGE'].split(':'))
    assert 1024<=first and first+3<=last<=65535
    host='sim.example.invalid';origin='https://'+host
    received=[];traps=[]
    storage=SimpleNamespace(name=os.environ['FH_TEST_STORAGE'])
    assert storage.name.startswith('/tmp/fh-caddy-') and '..' not in storage.name.split('/')
    os.mkdir(storage.name,0o700)
    class Backend(BaseHTTPRequestHandler):
        def do_GET(self):
            received.append((self.path,self.headers.get('Origin'),self.headers.get('Forwarded'),self.headers.get('X-Forwarded-Proto')))
            self.send_response(200);self.end_headers();self.wfile.write(b'fixture')
        def log_message(self,*args):pass
    class Trap(BaseHTTPRequestHandler):
        def do_GET(self):
            traps.append((self.server.server_port,self.path))
            self.send_response(418 if self.server.server_port==first+2 else 419);self.end_headers()
        def log_message(self,*args):pass
    api=HTTPServer(('127.0.0.1',first+2),Trap)
    static=HTTPServer(('127.0.0.1',first+3),Trap)
    trap_threads=[threading.Thread(target=server.serve_forever,daemon=True) for server in (api,static)]
    for thread in trap_threads:thread.start()
    backend=HTTPServer(('127.0.0.1',first+1),Backend)
    thread=threading.Thread(target=backend.serve_forever,daemon=True);thread.start()
    config=json.load(sys.stdin)
    config['admin']={'disabled':True,'config':{'persist':False}}
    server=config['apps']['http']['servers']['srv0']
    server['listen']=['127.0.0.1:'+str(first)]
    server['automatic_https']={'disable':True}
    def rewrite(value):
        if isinstance(value,dict):
            if 'dial' in value:
                value['dial']='127.0.0.1:'+str(first+1 if value['dial']=='127.0.0.1:9433' else first+2)
            if value.get('handler')=='file_server':
                value.clear();value.update(handler='reverse_proxy',upstreams=[{'dial':'127.0.0.1:'+str(first+3)}])
                return
            if value.get('handler')=='vars' and 'root' in value:value['root']=storage.name+'/empty-web'

            for child in value.values():rewrite(child)
        elif isinstance(value,list):
            for child in value:rewrite(child)
    rewrite(config)
    environment=dict(os.environ,HOME=storage.name,XDG_CONFIG_HOME=storage.name+'/config',XDG_DATA_HOME=storage.name+'/data')
    process=subprocess.Popen(['caddy','run','--config','-'],env=environment,stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        process.stdin.write(json.dumps(config).encode());process.stdin.close()
        for _ in range(100):
            try:
                with socket.create_connection(('127.0.0.1',first),timeout=.1):break
            except OSError:
                if process.poll() is not None:raise RuntimeError('fixture Caddy startup failed')
                time.sleep(.02)
        def check(path,status=404,headers=None,method='GET'):
            before=len(received);before_traps=len(traps)
            connection=http.client.HTTPConnection('127.0.0.1',first,timeout=2)
            try:
                connection.request(method,path,headers=headers or {})
                response=connection.getresponse();response.read()
                assert response.status==status,(path,response.status,status)
            finally:connection.close()
            assert len(received)-before==(1 if status==200 else 0), 'unexpected phone upstream reach'
            assert len(traps)==before_traps, 'reserved alias reached API/static trap'
        headers={'Host':host,'Origin':origin,'Connection':'keep-alive, Upgrade','Upgrade':'websocket','Forwarded':'for=untrusted'}
        paths=['/__fh_phone/9433/phone/'+suffix for suffix in ('ws','camera/ws','media/ws')]
        # Positive controls prove both alternate branches really are observable.
        for path,expected,port in (('/api/v1/fixture',418,first+2),('/fixture-static',419,first+3)):
            connection=http.client.HTTPConnection('127.0.0.1',first,timeout=2)
            try:
                connection.request('GET',path,headers={'Host':host})
                response=connection.getresponse();response.read();assert response.status==expected
                assert traps[-1][0]==port
            finally:connection.close()
        traps.clear()
        count=0
        for path in paths:
            check(path,200,headers);count+=1
            assert received[-1]==(path.removeprefix('/__fh_phone/9433'),origin,None,'https')
            for change in ({'Origin':'https://evil.invalid'},{'Origin':origin+':443'},{'Origin':''},{'Upgrade':''},{'Connection':'keep-alive'}):
                check(path,403,headers|change);count+=1
            check(path,403,headers,'POST');count+=1
            for bad in (path+'/',path+'?x=1',path+'?',path.replace('/9433/','/9434/'),path.replace('/9433/','/9430/'),
                        path.replace('/phone/','/%70hone/'),path.replace('/phone/','/phone/./'),path.replace('/phone/','/phone/x/../'),
                        path.replace('/phone/','/phone%2f'),path.replace('/__fh_phone/','/%5f_fh_phone/')):
                check(bad,404,headers);count+=1
        # Header placeholders join duplicate fields; exact comparison rejects both.
        for values in ((origin,origin),('https://evil.invalid',origin),(origin,'https://evil.invalid')):
            before=len(received)
            connection=http.client.HTTPConnection('127.0.0.1',first,timeout=2)
            try:
                connection.putrequest('GET',paths[0],skip_host=True)
                connection.putheader('Host',host)
                for value in values:connection.putheader('Origin',value)
                connection.putheader('Connection','Upgrade');connection.putheader('Upgrade','websocket')
                connection.endheaders()
                response=connection.getresponse();response.read()
                assert response.status==403 and len(received)==before
                count+=1
            finally:connection.close()
        for suffix in ('health','camera','media','ws/extra','../health'):
            check('/__fh_phone/9433/phone/'+suffix,404,headers);count+=1
        aliases=[
            '/__fh_phone/../api/v1/fixture', '/__fh_phone/%2e%2e/api/v1/fixture',
            '/%5f%5ffh_phone/%2e%2e/api/v1/fixture', '/__fh_phone//..//api/v1/fixture',
            '//__fh_phone/../api/v1/fixture', '/__FH_PHONE/../api/v1/fixture',
            '/__fh_phone/../fixture-static', '/__fh_phone/%2e%2e/fixture-static',
            '/%5f%5ffh_phone/../fixture-static', '/__FH_PHONE/../fixture-static',
            '/api/v1/../../__fh_phone/9433/phone/ws',
            '/static/../__fh_phone/9433/phone/ws', '/x/../__fh_phone/../api/v1/fixture',
            '/__fh_phone\\..\\api/v1/fixture',
        ]
        aliases += [path.replace('/phone/','/PHONE/') for path in paths]
        aliases += [path.replace('/9433/','//9433//') for path in paths]
        for alias in aliases:check(alias,404,headers);count+=1
        assert not traps
        print('PASS: '+str(count)+' exact route/Origin/upgrade/encoding boundaries; other upstreams never reached')
    finally:
        process.terminate()
        try:process.wait(timeout=3)
        except subprocess.TimeoutExpired:process.kill();process.wait()
        backend.shutdown();backend.server_close();thread.join(2)
        for server in (api,static):server.shutdown();server.server_close()
        for thread in trap_threads:thread.join(2)
        # Caller removes exactly FH_TEST_STORAGE after verifying all children exited.


if __name__=='__main__':main()
