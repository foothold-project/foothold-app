"""Cross-package reviewed Windows binaries on Linux, without running a PE file."""
from email.parser import BytesParser
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import zipfile

from urllib.request import urlopen

from build import HERE, ROOT, SDK_COMMIT, fetch, unpack, group_pins


def unzip(source, target):
    with zipfile.ZipFile(source) as archive:
        for item in archive.infolist():
            path = PurePosixPath(item.filename)
            if path.is_absolute() or '..' in path.parts or '\\' in item.filename:
                raise ValueError('unsafe zip member')
            if item.is_dir():
                continue
            dest = target/path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(archive.read(item))


def install_wheel(wheel, site):
    with zipfile.ZipFile(wheel) as archive:
        for item in archive.infolist():
            parts = PurePosixPath(item.filename).parts
            if item.is_dir():
                continue
            if not parts or '..' in parts or PurePosixPath(item.filename).is_absolute() or '\\' in item.filename:
                raise ValueError('unsafe wheel member')
            if parts[0].endswith('.data'):
                if len(parts) < 3 or parts[1] not in ('purelib','platlib'):
                    # Entry-point scripts are intentionally unused; the single
                    # app launcher is constructed below from reviewed distlib.
                    if len(parts) >= 2 and parts[1] == 'scripts':
                        continue
                    raise ValueError('unsupported wheel data layout')
                parts = parts[2:]
            dest = site.joinpath(*parts)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(archive.read(item))


def check_dependencies(wheels, groups, *, tools):
    """Equivalent metadata check for target CPython 3.10/Windows, never host markers."""
    sys.path.insert(0, str(tools))
    from pip._vendor.packaging.markers import default_environment
    from pip._vendor.packaging.requirements import Requirement
    from pip._vendor.packaging.specifiers import SpecifierSet
    env = default_environment()
    env.update(python_version='3.10', python_full_version='3.10.11', sys_platform='win32',
               platform_system='Windows', platform_machine='AMD64', os_name='nt', extra='')
    installed, records = {}, []
    normalize = lambda n: re.sub(r'[-_.]+','-',n).lower()
    for wheel in wheels:
        with zipfile.ZipFile(wheel) as archive:
            meta = BytesParser().parsebytes(archive.read(next(n for n in archive.namelist() if n.endswith('.dist-info/METADATA'))))
        if meta.get('Requires-Python') and '3.10.11' not in SpecifierSet(meta['Requires-Python']):
            raise ValueError('wheel does not support Python 3.10: '+wheel.name)
        installed[normalize(meta['Name'])] = meta['Version']
        records.extend(meta.get_all('Requires-Dist', []))
    for name, version in group_pins(groups).items():
        if installed.get(name) != version:
            raise ValueError('missing reviewed Windows extra wheel: '+name+'=='+version)
    for raw in records:
        requirement = Requirement(raw)
        if requirement.marker and not requirement.marker.evaluate(env):
            continue
        version = installed.get(normalize(requirement.name))
        if version is None or version not in requirement.specifier:
            raise ValueError('unsatisfied Windows wheel dependency: '+raw)
    return installed


def extra_wheels(groups, lock, cache, *, tools):
    sys.path.insert(0,str(tools))
    from pip._vendor.packaging.tags import cpython_tags, compatible_tags
    from pip._vendor.packaging.utils import parse_wheel_filename
    existing = {re.sub(r'[-_.]+','-',a['name'].split('-')[0]).lower():a['name'].split('-')[1]
                for a in lock if a['name'].endswith('.whl')}
    tags = list(cpython_tags((3,10),abis=['cp310'],platforms=['win_amd64']))
    tags += list(compatible_tags((3,10),interpreter='cp310',platforms=['win_amd64']))
    ranks = {tag:i for i,tag in reversed(list(enumerate(tags)))}
    resolved = []
    for name,version in group_pins(groups).items():
        if existing.get(name)==version:
            continue
        if name in existing:
            raise ValueError('pyproject pin differs from reviewed Windows lock: '+name)
        with urlopen(f'https://pypi.org/pypi/{name}/{version}/json',timeout=30) as response:
            files = json.load(response)['urls']
        choices = []
        for item in files:
            if item['packagetype']!='bdist_wheel':
                continue
            supported = parse_wheel_filename(item['filename'])[3]
            priority = min((ranks[t] for t in supported if t in ranks),default=None)
            if priority is not None:
                choices.append((priority,item['filename'],item))
        if not choices:
            raise ValueError('no cp310 Windows amd64 wheel available: '+name+'=='+version)
        item = min(choices,key=lambda value:value[:2])[2]
        asset = dict(name=item['filename'],url=item['url'],sha256=item['digests']['sha256'])
        resolved.append((fetch(asset,cache),asset))
    return resolved


def make_launcher(stub, target):
    script = b'from foothold_agent.desktop.windows_launch import main\nmain()\n'
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('__main__.py', script)
    target.write_bytes(stub + b'#!<launcher_dir>\\python\\pythonw.exe -I\n' + buffer.getvalue())


def uninstall_script():
    # Defer deletion until the bundled Python exits: it may itself live in the
    # installed tree. Remove every installed version even from a downloaded ZIP.
    return ('@echo off\r\n"%~dp0python\\python.exe" -I -c '
            '"from foothold_agent.desktop.windows_launch import uninstall; uninstall()"\r\n'
            'if errorlevel 1 exit /b 1\r\ncd /d "%TEMP%"\r\n(\r\n'
            'if exist "%LOCALAPPDATA%\\foothold\\robot" rmdir /s /q "%LOCALAPPDATA%\\foothold\\robot"\r\n'
            'if exist "%LOCALAPPDATA%\\foothold\\robot" exit /b 1\r\n'
            'if exist "%~dp0" rmdir /s /q "%~dp0"\r\n)\r\n')


def build(server, output, version):
    # Shared CLI validates origin/output/version before this function downloads.
    output.mkdir(parents=True, exist_ok=True)
    cache = output/'cache'
    cache.mkdir(exist_ok=True)
    lock = json.loads((HERE/'windows-inputs.lock.json').read_text())
    assets = {a['name']:fetch(a,cache) for a in lock}
    stage = output/'windows-stage'
    if stage.exists():
        shutil.rmtree(stage)
    root = stage/'FOOTHOLD 로봇 연결'
    root.mkdir(parents=True)
    python = root/'python'
    python.mkdir()
    unzip(assets['python-3.10.11-embed-amd64.zip'], python)
    site = python/'Lib/site-packages'
    site.mkdir(parents=True)
    tools = output/'windows-build-tools'
    if tools.exists():
        shutil.rmtree(tools)
    tools.mkdir()
    # Build backend only: no pip install into the host, no venv/system packages.
    for name, source in assets.items():
        if name.startswith(('pip-','setuptools-','wheel-','packaging-')):
            install_wheel(source, tools)
    env = {k:v for k,v in os.environ.items() if not k.startswith(('PYTHON','PIP_','CYCLONEDDS_','LD_'))}
    env.update(PYTHONNOUSERSITE='1', PIP_CONFIG_FILE=os.devnull, SOURCE_DATE_EPOCH='1794355200')
    script = ('import sys; sys.path.insert(0,sys.argv[1]); '
              'from pip._vendor import tomli; import json; '
              'p=tomli.load(open(sys.argv[2],"rb"))["project"]["optional-dependencies"]; '
              'print(json.dumps({k:p[k] for k in ("setup","go2-readonly","slam") if k in p}))')
    groups = json.loads(subprocess.run([sys.executable,'-I','-c',script,str(tools),str(ROOT/'apps/agent/pyproject.toml')],
                                      env=env,check=True,capture_output=True,text=True).stdout)
    wheels = root/'wheels'
    wheels.mkdir()
    for name, source in assets.items():
        if name.endswith('.whl'):
            shutil.copy2(source,wheels/name)
    for path,asset in extra_wheels(groups,lock,cache,tools=tools):
        shutil.copy2(path,wheels/path.name)
        lock.append(asset)
    source = output/'windows-sdk-source'
    if source.exists():
        shutil.rmtree(source)
    source.mkdir()
    unpack(assets['sdk.tar.gz'],source)
    sdk = next(source.iterdir())
    agent = output/'windows-agent-source'
    if agent.exists():
        shutil.rmtree(agent)
    shutil.copytree(ROOT/'apps/agent',agent,ignore=shutil.ignore_patterns(
        'installer','tests','__pycache__','*.egg-info','build','*.pyc'))
    for directory in (sdk,agent):
        code = ('import sys; sys.path.insert(0,sys.argv[1]); '
                'from setuptools.build_meta import build_wheel; build_wheel(sys.argv[2])')
        subprocess.run([sys.executable,'-I','-c',code,str(tools),str(wheels)],cwd=directory,env=env,check=True,
                       stdout=subprocess.DEVNULL)
    installed = check_dependencies(sorted(wheels.glob('*.whl')), groups, tools=tools)
    for wheel in sorted(wheels.glob('*.whl')):
        install_wheel(wheel,site)
    dist = next(site.glob('unitree_sdk2py-*.dist-info'))
    (dist/'direct_url.json').write_text(json.dumps(dict(url='https://github.com/unitreerobotics/unitree_sdk2_python.git',
        vcs_info=dict(vcs='git',commit_id=SDK_COMMIT,requested_revision=SDK_COMMIT))))
    # Explicit isolated search path; site processing enables wheel DLL helpers
    # but never user site/PYTHONPATH or the current working directory.
    (python/'python310._pth').write_text('python310.zip\n.\nLib/site-packages\nimport site\n')
    with zipfile.ZipFile(next(p for n,p in assets.items() if n.startswith('distlib-'))) as archive:
        make_launcher(archive.read('distlib/w64.exe'),root/'FOOTHOLD 로봇 연결.exe')
    (root/'연결 프로그램 제거.cmd').write_text(uninstall_script(), encoding='ascii')
    (root/'server.json').write_text(json.dumps(dict(server=server.rstrip('/')))+'\n')
    agent_wheel = next(wheels.glob('foothold_agent-*.whl'))
    build_id = hashlib.sha256((server.rstrip('/')+'\n'+version+'\n').encode()+agent_wheel.read_bytes()).hexdigest()[:16]
    (root/'version.json').write_text(json.dumps(dict(version=version,build_id=build_id))+'\n')
    (root/'inputs.lock.json').write_text(json.dumps(lock,indent=2)+'\n')
    (root/'extras.json').write_text(json.dumps(groups,indent=2)+'\n')
    (root/'packages.json').write_text(json.dumps(installed,indent=2)+'\n')
    (root/'시작 안내.txt').write_text('ZIP의 모두 압축 풀기를 누른 다음 FOOTHOLD 로봇 연결.exe를 더블클릭하세요.\n'
        '사용자 폴더에 설치하고 바탕 화면·시작 메뉴에 아이콘을 만듭니다.\n'
        'SmartScreen: 추가 정보 → 실행. 유선 설정 단추를 누를 때만 관리자 확인(UAC)이 필요합니다.\n'
        'Windows 10/11 x64 일반 데스크톱용입니다. Windows N은 Media Feature Pack이 필요합니다.\n'
        '키는 %APPDATA%\\foothold\\agent.json에 남습니다. 실제 Windows 실행 검증 전 개발판입니다.\n',encoding='utf-8-sig')
    # No PE imports here: hash/architecture checks are metadata-only on Linux.
    sys.path.insert(0,str(ROOT/'apps/agent'))
    from foothold_agent.setup.windows_preflight import pe_amd64
    pe_files = [p for p in python.rglob('*') if p.suffix.lower() in ('.pyd','.dll')]
    if not pe_files or any(not pe_amd64(p.read_bytes()) for p in pe_files):
        raise ValueError('non-amd64 native binary in Windows bundle')
    result = output/f'foothold-robot_{version}_windows_amd64.zip'
    with zipfile.ZipFile(result,'w',zipfile.ZIP_DEFLATED,compresslevel=3) as archive:
        for path in sorted(stage.rglob('*')):
            if path.is_file():
                archive.write(path,path.relative_to(stage))
    checksum = hashlib.sha256(result.read_bytes()).hexdigest()
    result.with_name(result.name+'.sha256').write_text(checksum+'  '+result.name+'\n')
    (output/(result.name+'.contents.txt')).write_text('\n'.join(zipfile.ZipFile(result).namelist())+'\n')
    print(json.dumps(dict(artifact=str(result),bytes=result.stat().st_size,sha256=checksum,platform='windows')))
    return result
