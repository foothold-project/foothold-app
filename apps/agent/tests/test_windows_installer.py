"""Windows branches run on Linux with fake PowerShell, files and byte locks; no DDS."""
import asyncio
import base64
from copy import deepcopy
import importlib.util
import io
import json
from pathlib import Path
import re
import struct
import sys
from types import SimpleNamespace as NS
import zipfile

import pytest

from foothold_agent.desktop import windows as win
from foothold_agent.desktop import __main__ as desktop
from foothold_agent.setup import windows as private
from foothold_agent.setup import platform as host
from foothold_agent.setup import windows_preflight as preflight
from foothold_agent.setup.storage import Credentials

INSTALLER = Path(__file__).resolve().parents[1]/'installer'


@pytest.fixture(autouse=True)
def fake_socket_interface_names(monkeypatch):
    monkeypatch.setattr(win,'canonical_name',lambda index:f'ethernet_{index}')


def data(address='192.168.123.200', prefix=24):
    return dict(adapters=[dict(Name='로봇 Ethernet 2',Index=7,Guid='01234567-89ab-cdef-0123-456789abcdef',
                              Mac='02-11-22-33-44-55',Up=True,Physical=True,Virtual=False,Type=6)],
                addresses=[] if address is None else [dict(InterfaceIndex=7,IPAddress=address,PrefixLength=prefix,AddressState=4)],
                defaults=[],neighbors=[])


def test_powershell_json_retains_unicode_and_is_read_only(monkeypatch):
    calls=[]
    monkeypatch.setattr(private,'powershell',lambda script: calls.append(script) or NS(stdout=json.dumps(data())))
    assert private.metadata() == data()
    assert all(s in calls[0] for s in ('Get-NetAdapter','Get-NetIPAddress','Get-NetRoute','::/0'))
    assert not re.search(r'\b(Set-|Remove-|New-|netsh)',calls[0])
    monkeypatch.setattr(private,'powershell',lambda _:NS(stdout='{"adapters":null}'))
    with pytest.raises(ValueError): private.metadata()


def test_powershell_command_uses_encoded_unicode_without_profiles(monkeypatch,tmp_path):
    calls=[]
    monkeypatch.setenv('SystemRoot',str(tmp_path))
    monkeypatch.setattr(private.subprocess,'run',lambda argv,**kw:calls.append((argv,kw)) or NS(stdout=''))
    private.powershell("Write-Output '로봇'",timeout=3)
    argv,kw=calls[0]
    assert argv[0] == str(tmp_path/'System32/WindowsPowerShell/v1.0/powershell.exe')
    assert '-NoProfile' in argv and '-NonInteractive' in argv
    assert "Write-Output '로봇'" in base64.b64decode(argv[-1]).decode('utf-16le')
    assert kw['timeout'] == 3 and kw['check'] and not kw.get('shell')


@pytest.mark.parametrize('reason',['wifi','virtual','nonphysical','down','default4','default6','other_network',
                                    'robot','orin','prefix','tentative','xml','missing_state'])
def test_never_selects_unsafe_windows_nic(reason):
    value=data(); row=value['adapters'][0]
    if reason=='wifi': row['Type']=71
    if reason=='virtual': row['Virtual']=True
    if reason=='nonphysical': row['Physical']=False
    if reason=='down': row['Up']=False
    if reason.startswith('default'):value['defaults']=[dict(InterfaceIndex=7)]
    if reason=='other_network':value['addresses'][0]['IPAddress']='10.0.0.4'
    if reason=='robot':value['addresses'][0]['IPAddress']='192.168.123.161'
    if reason=='orin':value['addresses'][0]['IPAddress']='192.168.123.18'
    if reason=='prefix':value['addresses'][0]['PrefixLength']=16
    if reason=='tentative':value['addresses'][0]['AddressState']=1
    if reason=='missing_state':value['addresses'][0].pop('AddressState')
    if reason=='xml':row['Name']='Ethernet" injected="yes'
    assert win.candidates(query_fn=lambda:value)==[]


def test_dedicated_unicode_nic_and_preferred_address_are_selected():
    found=win.candidates(query_fn=lambda:data())
    assert len(found)==1 and found[0].name=='ethernet_7' and found[0].dds_name=='로봇 Ethernet 2' and found[0].index==7
    assert found[0].mac=='02:11:22:33:44:55'
    assert found[0].addresses==( ('192.168.123.200',24), )


@pytest.mark.parametrize('address',[None,'169.254.2.3'])
def test_empty_or_windows_apipa_can_be_configured_but_cannot_join_dds(address):
    value=data(address,16 if address else 24)
    assert win.candidates(query_fn=lambda:value)==[]
    assert win.available(query_fn=lambda:value)==[dict(name='ethernet_7',mac='02:11:22:33:44:55',label='로봇 Ethernet 2')]


def test_uac_child_rechecks_identity_routes_and_only_changes_selected_adapter():
    calls=[]; value=data(None)
    value['neighbors']=[dict(IPAddress='192.168.123.200')]
    assert win.configure('ethernet_7',query_fn=lambda:value,run=lambda script,**kw:calls.append(script))=='192.168.123.201'
    assert len(calls)==1 and '-Verb RunAs' in calls[0] and '-Wait' in calls[0]
    encoded=re.search(r"'-EncodedCommand','([A-Za-z0-9+/=]+)'",calls[0]).group(1)
    child=base64.b64decode(encoded).decode('utf-16le')
    assert child.index('Get-NetAdapter') < child.index('netsh.exe')
    for required in ('InterfaceGuid','HardwareInterface','ifType','::/0','0.0.0.0/0',"$index=7",'gateway=none','address=none','mask=255.255.255.0','Preferred'):
        assert required in child
    assert child.count('& "$env:SystemRoot\\System32\\netsh.exe"')==2
    value['defaults']=[dict(InterfaceIndex=7)]
    with pytest.raises(PermissionError): win.configure('ethernet_7',query_fn=lambda:value,run=lambda *a,**k:calls.append('bad'))
    assert len(calls)==1


def test_uac_cancel_is_propagated():
    def cancel(*args,**kwargs): raise PermissionError('cancel')
    with pytest.raises(PermissionError):win.configure('ethernet_7',query_fn=lambda:data(None),run=cancel)


def test_windows_key_acl_protects_before_secret_write_and_atomic_replace(tmp_path,monkeypatch):
    path=tmp_path/'private/agent.json'; calls=[]
    def acl(p,*,create=False):
        calls.append((Path(p),create,Path(p).read_bytes() if Path(p).is_file() else None))
    monkeypatch.setattr(private,'private_acl',acl)
    credentials=Credentials('00000000-0000-4000-8000-000000000001','1234-5678','fake-token','wss://example.invalid/api/v1/agent/ws')
    private.save_credentials(credentials,path)
    assert private.load_credentials(path)==credentials
    assert any(p.name.startswith('.agent-') and create and content==b'' for p,create,content in calls)
    assert not list(path.parent.glob('.agent-*'))
    before=path.read_bytes()
    monkeypatch.setattr(private,'private_acl',lambda *a,**k:(_ for _ in ()).throw(PermissionError('broad ACL')))
    with pytest.raises(PermissionError):private.load_credentials(path)
    with pytest.raises(PermissionError):private.save_credentials(credentials,path)
    assert path.read_bytes()==before


def test_acl_checks_owner_protected_exact_dacl_and_never_grants_other_users(tmp_path,monkeypatch):
    path=tmp_path/'agent.json';path.touch();calls=[]
    monkeypatch.setattr(private,'powershell',lambda script:calls.append(script))
    private.private_acl(path,create=True)
    script=calls[0]
    for required in ('SetOwner','SetAccessRuleProtection($true,$false)','Set-Acl','AreAccessRulesProtected','GetOwner',"$r.Count -ne 1",'FullControl','IsInherited'):
        assert required in script
    assert 'Everyone' not in script and 'Administrators' not in script
    calls.clear();private.private_acl(path)
    assert 'Set-Acl' not in calls[0]


def test_private_paths_reject_symlinks_and_hardlinked_credentials(tmp_path,monkeypatch):
    real=tmp_path/'real';real.mkdir();link=tmp_path/'link';link.symlink_to(real)
    with pytest.raises(PermissionError):private.load_credentials(link/'agent.json')
    monkeypatch.setattr(private,'private_acl',lambda *a,**k:None)
    path=real/'agent.json';path.write_text('{}');(real/'linked.json').hardlink_to(path)
    with pytest.raises(PermissionError):private.load_credentials(path)


def test_startup_shortcut_enable_disable_touches_only_own_link(tmp_path,monkeypatch):
    monkeypatch.setenv('APPDATA',str(tmp_path/'roaming'))
    executable=tmp_path/'app/FOOTHOLD 로봇 연결.exe';executable.parent.mkdir();executable.touch();calls=[]
    other=win.startup_path().with_name('Other.lnk');other.parent.mkdir(parents=True);other.write_text('keep')
    def run(script):
        calls.append(script);win.startup_path().write_text('fake shortcut')
    assert not win.autostart_enabled()
    win.set_autostart(True,run=run,executable=executable)
    assert win.autostart_enabled() and '--autostart' in calls[0] and str(executable) in calls[0]
    win.set_autostart(False,run=run)
    assert not win.autostart_enabled() and other.read_text()=='keep' and len(calls)==1


def test_windows_duplicate_instance_lock_fails_closed_and_releases_after_exit(tmp_path):
    class API:
        LK_NBLCK=1;LK_UNLCK=2
        active=False
        def locking(self,fd,operation,n):
            assert n==1
            if operation==self.LK_NBLCK:
                if self.active:raise OSError('busy')
                self.active=True
            else:self.active=False
    api=API();path=tmp_path/'cache/desktop.lock'
    with win.InstanceLock(path,api=api):
        with pytest.raises(BlockingIOError):
            with win.InstanceLock(path,api=api):pass
    assert not api.active
    with win.InstanceLock(path,api=api): assert api.active
    assert not api.active


def test_quit_requests_shared_stop_path_and_never_calls_os_kill(monkeypatch):
    calls=[];control=desktop.Controls();control.request_stop=lambda:calls.append('stop')
    monkeypatch.setattr(desktop.os,'kill',lambda *a:pytest.fail('must run shared STOP cleanup'))
    class Timer:
        def __init__(self,delay,callback):self.callback=callback
        def start(self):self.callback()
    monkeypatch.setattr(desktop.threading,'Timer',Timer)
    control.action(dict(action='quit'))
    assert calls==['stop']


def test_windows_signal_handlers_set_and_restore_shared_stop(monkeypatch):
    from types import SimpleNamespace
    handlers={};calls=[]
    monkeypatch.setattr(host,'os',SimpleNamespace(name='nt'))
    monkeypatch.setattr(host.signal,'getsignal',lambda sig:'prior')
    monkeypatch.setattr(host.signal,'signal',lambda sig,handler:handlers.__setitem__(sig,handler))
    async def scenario():
        stop=asyncio.Event();restore=host.install_stop_handlers(stop)
        handlers[host.signal.SIGTERM](None,None)
        await asyncio.sleep(0)
        assert stop.is_set()
        restore()
    asyncio.run(scenario())
    assert set(handlers.values())=={'prior'}


def pe(machine=0x8664):
    result=bytearray(256);result[:2]=b'MZ';struct.pack_into('<I',result,60,128)
    result[128:132]=b'PE\0\0';struct.pack_into('<H',result,132,machine);struct.pack_into('<H',result,152,0x20b)
    return bytes(result)


def test_preflight_pe_is_metadata_only_and_rejects_other_architectures():
    assert preflight.pe_amd64(pe())
    assert not preflight.pe_amd64(pe(0x14c)) and not preflight.pe_amd64(b'bad')


def test_installed_dds_binary_must_match_reviewed_wheel(tmp_path,monkeypatch):
    import hashlib
    wheel=tmp_path/preflight.DDS_WHEEL
    native='cyclonedds/.libs/ddsc.dll';installed=tmp_path/'site'/native;installed.parent.mkdir(parents=True)
    installed.write_bytes(pe())
    with zipfile.ZipFile(wheel,'w') as archive:archive.writestr(native,pe())
    monkeypatch.setattr(preflight,'DDS_SHA256',hashlib.sha256(wheel.read_bytes()).hexdigest())
    monkeypatch.setattr(preflight.metadata,'distribution',lambda _:NS(locate_file=lambda n:tmp_path/'site'/n))
    assert preflight.verified_dds(tmp_path)
    installed.write_bytes(pe()+b'changed')
    assert not preflight.verified_dds(tmp_path)


def load_builder(monkeypatch):
    monkeypatch.syspath_prepend(str(INSTALLER))
    import build_windows
    return build_windows


def test_distlib_launcher_embeds_relative_isolated_python(monkeypatch,tmp_path):
    builder=load_builder(monkeypatch);target=tmp_path/'app.exe'
    builder.make_launcher(b'MZ-fixture',target)
    assert b'#!<launcher_dir>\\python\\pythonw.exe -I\n' in target.read_bytes()
    with zipfile.ZipFile(target) as archive:
        assert 'windows_launch' in archive.read('__main__.py').decode()


def test_wheel_unpack_refuses_traversal_and_relocates_data(monkeypatch,tmp_path):
    builder=load_builder(monkeypatch);wheel=tmp_path/'fixture.whl';site=tmp_path/'site'
    with zipfile.ZipFile(wheel,'w') as archive:
        archive.writestr('example-1.data/purelib/example.py','ok')
    builder.install_wheel(wheel,site)
    assert (site/'example.py').read_text()=='ok'
    with zipfile.ZipFile(wheel,'w') as archive:archive.writestr('../outside','bad')
    with pytest.raises(ValueError):builder.install_wheel(wheel,site)
    assert not (tmp_path/'outside').exists()


def test_windows_inputs_cover_runtime_and_windows_transitive_dependencies():
    lock=json.loads((INSTALLER/'windows-inputs.lock.json').read_text())
    assert all(len(a['sha256'])==64 and a['url'].startswith('https://') for a in lock)
    names={a['name'].split('-')[0] for a in lock}
    assert {'cyclonedds','numpy','opencv_python','websockets','qrcode','zeroconf','colorama','distlib','pip'} <= names
    dds=next(a for a in lock if a['name']==preflight.DDS_WHEEL)
    assert dds['sha256']==preflight.DDS_SHA256


def test_runtime_native_nic_recheck_does_not_relax_identity_or_defaults():
    from foothold_agent.setup.windows_nic import matches
    nic=win.candidates(query_fn=lambda:data())[0]
    row=dict(index=7,name=nic.dds_name,up=True,type=6,mac=nic.mac,
             addresses=[('192.168.123.200',24,4)],gateways=[])
    assert matches(nic,query=lambda:[row],routes=lambda:set())
    assert not matches(nic,query=lambda:[row],routes=lambda:{7})  # on-link or IPv6 default
    for field,value in [('name','different'),('index',8),('up',False),('type',71),('mac','00:00:00:00:00:01'),
                        ('addresses',[('192.168.123.200',24,1)]),('gateways',[True]),
                        ('addresses',[('10.0.0.1',24,4)]),('addresses',[])]:
        assert not matches(nic,query=lambda:[dict(row,**{field:value})],routes=lambda:set())
    def failure():raise OSError('metadata unavailable')
    assert not matches(nic,query=failure,routes=lambda:set())


def test_native_iphelper_decodes_adapter_and_ipv4_without_loading_windows_dll():
    import ctypes as C
    from foothold_agent.setup import windows_nic as native
    address=C.create_string_buffer(b'\x02\x00\x00\x00\xc0\xa8\x7b\xc8'+b'\x00'*8)
    unicast=native.Unicast();unicast.length=C.sizeof(unicast);unicast.address.pointer=C.addressof(address)
    unicast.address.length=16;unicast.dad_state=4;unicast.prefix=24
    row=native.Adapter();row.length=C.sizeof(row);row.index=7;row.friendly='로봇 Ethernet 2'
    row.if_type=6;row.oper_status=1;row.mac_length=6;row.mac[:6]=[2,17,34,51,68,85]
    row.unicast=C.pointer(unicast)
    def api(family,flags,reserved,buffer,size):
        assert family==0 and flags & 128
        C.memmove(buffer,C.addressof(row),C.sizeof(row));return 0
    result=native.adapters(api=api)
    assert result==[dict(index=7,name='로봇 Ethernet 2',up=True,type=6,mac='02:11:22:33:44:55',
                         addresses=[('192.168.123.200',24,4)],gateways=[])]


def test_native_routes_include_ipv6_and_onlink_defaults_and_free_table():
    import ctypes as C
    from foothold_agent.setup import windows_nic as native
    class Table(C.Structure):
        _fields_=[('count',native.U32),('rows',native.Route*3)]
    table=Table();table.count=3
    for row,index,prefix in zip(table.rows,[7,8,9],[0,0,24]):
        row.index=index;row.destination.prefix_length=prefix
    freed=[]
    class API:
        def GetIpForwardTable2(self,family,pointer):
            assert family==0
            C.cast(pointer,C.POINTER(C.c_void_p))[0]=C.addressof(table);return 0
        def FreeMibTable(self,pointer):freed.append(pointer.value)
    assert native.default_indexes(library=API())=={7,8}
    assert freed==[C.addressof(table)]


def test_windows_readonly_adapter_supports_friendly_names_and_only_relocates_trace(tmp_path,monkeypatch):
    from foothold_agent.go2_readonly import sdk
    from test_go2_readonly import fake_sdk, measured
    calls,callbacks,_=fake_sdk(monkeypatch)
    channel=sys.modules['unitree_sdk2py.core.channel']
    channel.ChannelFactoryInitialize.__module__=channel.__name__
    channel.ChannelConfigHasInterface='<NetworkInterface name="$__IF_NAME__$"/><OutputFile>/tmp/cdds.LOG</OutputFile>'
    monkeypatch.setenv('LOCALAPPDATA',str(tmp_path))
    monkeypatch.setattr(sdk,'os',NS(name='nt',environ=private.os.environ))
    state,clock=measured()
    subscriptions=sdk.Subscriptions(state,'ethernet_7',dds_name='로봇 Ethernet 2')
    subscriptions.start()
    assert subscriptions.nic=='ethernet_7'  # matches the unchanged connect_approved socket identity guard
    assert calls[0]==('initialize',0,'로봇 Ethernet 2')
    assert sum(c[0]=='subscribe' for c in calls)==2
    assert 'name="$__IF_NAME__$"' in channel.ChannelConfigHasInterface
    assert str(tmp_path/'foothold/cache/cdds.LOG') in channel.ChannelConfigHasInterface
    for name in ['a<b','a&b','a"b',"a'b"]:
        with pytest.raises(ValueError):sdk.Subscriptions(state,name)
    subscriptions.close()


def wheel_metadata(path,name,version,requires=()):
    with zipfile.ZipFile(path,'w') as archive:
        archive.writestr(f'{name}-{version}.dist-info/METADATA',f'Name: {name}\nVersion: {version}\nRequires-Python: >=3.10\n'+''.join('Requires-Dist: '+r+'\n' for r in requires))


def test_cross_dependency_check_uses_windows_cp310_markers(monkeypatch,tmp_path):
    builder=load_builder(monkeypatch)
    first=tmp_path/'example.whl';second=tmp_path/'colorama.whl'
    wheel_metadata(first,'example','1.0',['colorama==0.4.6; sys_platform == "win32"',
                                         'unavailable; python_version >= "3.11"',
                                         'also-unavailable; sys_platform == "linux"'])
    with pytest.raises(ValueError,match='unsatisfied Windows wheel dependency'):
        builder.check_dependencies([first],{},tools=tmp_path)
    wheel_metadata(second,'colorama','0.4.6')
    assert builder.check_dependencies([first,second],{'slam':['example==1.0']},tools=tmp_path)=={'example':'1.0','colorama':'0.4.6'}
    with pytest.raises(ValueError,match='missing reviewed Windows extra'):
        builder.check_dependencies([first,second],{'slam':['example==2.0']},tools=tmp_path)


def test_new_extra_chooses_cp310_windows_and_rejects_missing_binary_or_lock_conflict(monkeypatch,tmp_path):
    builder=load_builder(monkeypatch);calls=[]
    info={'urls':[dict(packagetype='bdist_wheel',filename=n,url='https://wheel.invalid/'+n,digests=dict(sha256='a'*64)) for n in [
        'example-1.0-cp312-cp312-win_amd64.whl','example-1.0-cp310-cp310-manylinux2014_x86_64.whl',
        'example-1.0-cp310-cp310-win_amd64.whl']]}
    monkeypatch.setattr(builder,'urlopen',lambda *a,**kw:io.BytesIO(json.dumps(info).encode()))
    monkeypatch.setattr(builder,'fetch',lambda asset,cache:calls.append(asset) or cache/asset['name'])
    result=builder.extra_wheels({'slam':['example==1.0']},[],tmp_path,tools=tmp_path)
    assert result[0][0].name=='example-1.0-cp310-cp310-win_amd64.whl'
    assert calls[0]['sha256']=='a'*64
    with pytest.raises(ValueError,match='differs from reviewed Windows lock'):
        builder.extra_wheels({'slam':['example==1.0']},[dict(name='example-2.0-py3-none-any.whl')],tmp_path,tools=tmp_path)
    info['urls']=info['urls'][:2]
    with pytest.raises(ValueError,match='no cp310 Windows amd64 wheel'):
        builder.extra_wheels({'slam':['example==1.0']},[],tmp_path,tools=tmp_path)


def test_bootstrap_installs_version_and_server_identity_preserving_autostart_optout(tmp_path,monkeypatch):
    from foothold_agent.desktop import windows_launch as launch
    source=tmp_path/'download';source.mkdir();(source/'version.json').write_text('{"version":"0.2.0-1","build_id":"abcd"}')
    (source/'FOOTHOLD 로봇 연결.exe').write_bytes(b'MZ-fixture');(source/'server.json').write_text('{"server":"https://example.invalid"}')
    monkeypatch.setenv('LOCALAPPDATA',str(tmp_path/'local'));monkeypatch.setenv('APPDATA',str(tmp_path/'roaming'))
    monkeypatch.setattr(launch,'powershell',lambda script:NS(stdout=str(tmp_path/'desktop')))
    links=[];starts=[]
    monkeypatch.setattr(launch,'shortcut',lambda path,target:links.append((path,target)))
    monkeypatch.setattr(win,'set_autostart',lambda enabled,**kw:starts.append((enabled,kw)))
    monkeypatch.setattr(win,'autostart_enabled',lambda:False)
    target=launch.install(source)
    assert target==tmp_path/'local/foothold/robot/0.2.0-1-abcd/FOOTHOLD 로봇 연결.exe'
    assert target.read_bytes()==b'MZ-fixture' and len(links)==2 and len(starts)==1
    assert launch.install(target.parent) is None
    assert launch.install(source)==target and len(starts)==1  # opt-out survives reinstall
    (source/'version.json').write_text('{"version":"0.2.0-1","build_id":"ef01"}')
    assert launch.install(source).parent.name=='0.2.0-1-ef01'
    assert target.exists()  # active/old binary is never overwritten


def parse_ps_single_literal(script):
    """Model PowerShell's five single-quote delimiters, returning unconsumed code."""
    quotes = "'\u2018\u2019\u201a\u201b"
    assert script[0] in quotes
    value, index = [], 1
    while index < len(script):
        char = script[index]
        if char in quotes:
            if index+1 < len(script) and script[index+1] == char:
                value.append(char)
                index += 2
                continue
            return ''.join(value), script[index+1:]
        value.append(char)
        index += 1
    raise AssertionError('unterminated PowerShell literal')


@pytest.mark.parametrize('quote', ["'", '\u2018', '\u2019', '\u201a', '\u201b'])
def test_user_path_quotes_stay_data_in_acl_and_shortcut_scripts(tmp_path, monkeypatch, quote):
    from foothold_agent.desktop import windows_launch as launch
    directory = tmp_path/f'O{quote}Neil; Write-Output injected; #'
    directory.mkdir()
    path = directory/'agent.json'
    path.touch()
    scripts = []
    monkeypatch.setattr(private, 'powershell', lambda script: scripts.append(script))
    private.private_acl(path)
    decoded, rest = parse_ps_single_literal(scripts[0][len('$p='):])
    assert decoded == str(path)
    assert rest.startswith('; $sid=')
    monkeypatch.setattr(launch, 'powershell', lambda script: scripts.append(script))
    launch.shortcut(directory/'FOOTHOLD.lnk', directory/'FOOTHOLD.exe')
    shortcut = scripts[-1].split('.CreateShortcut(', 1)[1]
    decoded, rest = parse_ps_single_literal(shortcut)
    assert decoded == str(directory/'FOOTHOLD.lnk') and rest.startswith('); ')
    decoded, rest = parse_ps_single_literal(scripts[-1].split('$s.TargetPath=', 1)[1])
    assert decoded == str(directory/'FOOTHOLD.exe') and rest.startswith('; ')


@pytest.mark.parametrize('quote', ['\u2018', '\u2019', '\u201a', '\u201b'])
def test_smart_quote_adapter_names_never_reach_elevated_script(quote):
    value = data(None)
    value['adapters'][0]['Name'] = f'Ethernet{quote}; Write-Output injected; #'
    assert win.available(query_fn=lambda: value) == []
    assert win.candidates(query_fn=lambda: value) == []
    calls = []
    with pytest.raises(PermissionError):
        win.configure('ethernet_7', query_fn=lambda: value,
                      run=lambda *args, **kwargs: calls.append(args))
    assert calls == []
