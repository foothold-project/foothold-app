"""Run a supplied adapted config against disposable loopback HTTP fixtures only.

Usage: FH_TEST_PORT_RANGE=19780:19799 python3 -B caddy_boundary.py < adapted.json
No TLS, admin API, production listeners, credentials or service changes.
Only disposable storage is used; config persistence is disabled.
"""
import http.client
import json
import os
import socket
import subprocess
import sys
import threading
import tempfile
import time
from http.server import BaseHTTPRequestHandler, HTTPServer


def main():
    first,last=map(int,os.environ['FH_TEST_PORT_RANGE'].split(':'))
    assert 1024<=first<last<=65535
    host='sim.example.invalid';origin='https://'+host
    received=[]
    class Backend(BaseHTTPRequestHandler):
        def do_GET(self):
            received.append((self.path,self.headers.get('Origin'),self.headers.get('Forwarded'),self.headers.get('X-Forwarded-Proto')))
            self.send_response(200);self.end_headers();self.wfile.write(b'fixture')
        def log_message(self,*args):pass
    backend=HTTPServer(('127.0.0.1',first+1),Backend)
    thread=threading.Thread(target=backend.serve_forever,daemon=True);thread.start()
    config=json.load(sys.stdin)
    config['admin']={'disabled':True,'config':{'persist':False}}
    server=config['apps']['http']['servers']['srv0']
    server['listen']=['127.0.0.1:'+str(first)]
    server['automatic_https']={'disable':True}
    def rewrite(value):
        if isinstance(value,dict):
            if value.get('dial')=='127.0.0.1:9433':value['dial']='127.0.0.1:'+str(first+1)
            for child in value.values():rewrite(child)
        elif isinstance(value,list):
            for child in value:rewrite(child)
    rewrite(config)
    storage=tempfile.TemporaryDirectory(prefix='fh-caddy-fixture-')
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
            before=len(received)
            connection=http.client.HTTPConnection('127.0.0.1',first,timeout=2)
            try:
                connection.request(method,path,headers=headers or {})
                response=connection.getresponse();response.read()
                assert response.status==status,(path,response.status,status)
            finally:connection.close()
            assert len(received)-before==(1 if status==200 else 0), 'unexpected upstream reach'
        headers={'Host':host,'Origin':origin,'Connection':'keep-alive, Upgrade','Upgrade':'websocket','Forwarded':'for=untrusted'}
        paths=['/__fh_phone/9433/phone/'+suffix for suffix in ('ws','camera/ws','media/ws')]
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
        print('PASS: '+str(count)+' exact route/Origin/upgrade/encoding boundaries; other upstreams never reached')
    finally:
        process.terminate()
        try:process.wait(timeout=3)
        except subprocess.TimeoutExpired:process.kill();process.wait()
        backend.shutdown();backend.server_close();thread.join(2)
        storage.cleanup()


if __name__=='__main__':main()
