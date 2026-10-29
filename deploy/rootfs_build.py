"""Pinned full-rootfs preparation, confined to one recipe-SHA directory.

No host install/registration/scripts, library loads, service activation or retry.
A failed operation retains the package latch and all private evidence.
"""
import sys
sys.dont_write_bytecode=True
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import shutil
import stat
import subprocess
import tempfile
from urllib.parse import urlsplit
from urllib.request import build_opener, HTTPSHandler, HTTPRedirectHandler
import zipfile

from . import sim_sysroot as shared, rootfs_plan as planner, rootfs_archive as archive

ROOT=Path('/opt/foothold-sim/rootfs')
CONTROL=frozenset(('RECIPE.json','MANIFEST.json','COMPLETE.json','foothold-runtime/identity.json'))
RESERVED=CONTROL|{'.stage','.archives','foothold-runtime'}
GENERATOR_FILES=('rootfs_build.py','rootfs_archive.py','rootfs_config.py','rootfs_probe.py','foothold-sim.slice')


def digest(data):return hashlib.sha256(shared.canonical(data)).hexdigest()


def private_json(path,mode=0o600):
    for parent in path.parents:
        info=parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:
            raise ValueError('untrusted private input parent')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    with os.fdopen(fd) as stream:
        info=os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=mode or info.st_size>32*1024**2:
            raise ValueError('untrusted private JSON input')
        return json.load(stream)


def generators():
    return {**{name:shared.sha(Path(__file__).with_name(name)) for name in GENERATOR_FILES},
        'control_requirements':shared.sha(Path(__file__).parents[1]/'apps/server/requirements.txt')}


def validate_plan(data):
    if (not isinstance(data,dict) or data.get('schema')!='foothold-rootfs-apt-plan/1'
            or data.get('runnable') is not False or data.get('status_empty') is not True
            or data.get('host_inventory_used') is not False or data.get('snapshot')!=planner.SNAPSHOT
            or data.get('status_sha256')!=hashlib.sha256(b'').hexdigest()
            or not shared.HASH.fullmatch(data.get('metadata_sha256',''))):
        raise ValueError('approved empty-status signed plan required')
    rows=data['packages'];seen={};pins=shared.requirements()
    for row in rows:
        if set(row)!={'name','version','sha256','filename','download_bytes','installed_bytes'}:
            raise ValueError('invalid plan package fields')
        name=row['name'];version=row['version'];filename=row['filename']
        if (not shared.NAME.fullmatch(name) or not shared.VERSION.fullmatch(version)
                or not shared.HASH.fullmatch(row['sha256']) or name in seen
                or shared.DRIVER_FORBIDDEN.search(name) or not filename.startswith('pool/')
                or any(x in ('','.','..') for x in filename.split('/'))
                or type(row['download_bytes']) is not int or not 0<row['download_bytes']<4*1024**3
                or type(row['installed_bytes']) is not int or row['installed_bytes']<0):
            raise ValueError('unapproved plan package')
        expected=pins.get(name)
        if name.startswith('ros-jazzy-nav2-'):expected='1.3.13'
        if name.startswith(('libprotobuf','python3-protobuf','protobuf-')):expected='3.21.12'
        if expected and shared.upstream(version)!=expected:raise ValueError('upstream pin changed')
        seen[name]=row
    if (not set(pins)|set(planner.BASE_ROOTS)<=set(seen) or len(rows)!=data['package_count']
            or len(rows)>2000 or sum(x['download_bytes'] for x in rows)!=data['download_bytes']
            or sum(x['installed_bytes'] for x in rows)!=data['installed_bytes']
            or data['installed_bytes']>archive.MAX_BYTES or data['download_bytes']>2*1024**3):
        raise ValueError('incomplete/oversized package closure')
    return seen


def wheel_name(name):return re.sub('[-_.]+','-',name).lower()


def validate_wheels(rows):
    if not isinstance(rows,list) or not rows or len(rows)>256:raise ValueError('hash-pinned wheel closure required')
    if any(type(row.get('size')) is not int for row in rows) or sum(row['size'] for row in rows)>1024**3:
        raise ValueError('wheel download envelope exceeded')
    required={'trimesh':'5.1.0'}
    requirements=Path(__file__).parents[1]/'apps/server/requirements.txt'
    for line in requirements.read_text().splitlines():
        match=re.fullmatch(r'([A-Za-z0-9_-]+)(?:\[[a-z,]+\])?==([0-9][A-Za-z0-9.+]*)',line)
        if not match:raise ValueError('control requirement is not an exact pin')
        required[wheel_name(match[1])]=match[2]
    seen={}
    for row in rows:
        if set(row)!={'name','version','filename','url','sha256','size'}:raise ValueError('wheel lock fields invalid')
        name=wheel_name(row['name']);filename=row['filename'];url=urlsplit(row['url'])
        if (not re.fullmatch('[a-z0-9][a-z0-9-]*',name) or name in seen
                or not shared.VERSION.fullmatch(row['version']) or not shared.HASH.fullmatch(row['sha256'])
                or type(row['size']) is not int or not 0<row['size']<=256*1024**2
                or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.+\-]*\.whl',filename)
                or url.scheme!='https' or url.hostname!='files.pythonhosted.org' or url.port is not None
                or url.username is not None or url.password is not None or url.query or url.fragment
                or not url.path.startswith('/packages/') or url.path.rsplit('/',1)[-1]!=filename):
            raise ValueError('unapproved exact wheel artifact')
        parts=filename[:-4].split('-')
        if len(parts)<5 or wheel_name(parts[0])!=name or parts[1]!=row['version']:
            raise ValueError('wheel filename identity mismatch')
        python,abi,platform=parts[-3:]
        if (not all(re.fullmatch(r'py[23]|cp3(?:[2-9]|1[0-2])',x) for x in python.split('.'))
                or abi not in ('none','abi3','cp312')
                or not all(re.fullmatch(r'any|(?:manylinux[0-9_]+|linux)_x86_64',x) for x in platform.split('.'))):
            raise ValueError('non-Noble/Python3.12 wheel')
        if name in required and row['version']!=required[name]:raise ValueError('direct wheel pin changed')
        seen[name]=row
    if not set(required)<=set(seen):raise ValueError('required direct wheel absent')
    return seen


def validate_recipe(recipe):
    if set(recipe)!={'schema','apt_plan','wheels','config','generators'} or recipe['schema']!=1:
        raise ValueError('invalid rootfs recipe')
    validate_plan(recipe['apt_plan']);validate_wheels(recipe['wheels'])
    from .rootfs_config import validate_config
    validate_config(recipe['config'])
    if recipe['generators']!=generators():raise ValueError('generator differs from reviewed recipe')
    return digest(recipe)


def verify_metadata(plan,work):
    cache=shared.ROOT/'apt'
    if shared.apt_metadata_digest(cache)!=plan['metadata_sha256']:raise ValueError('signed cache changed')
    (work/'home/gnupg').mkdir(parents=True,mode=0o700)
    (work/'tmp').mkdir(mode=0o700)
    shown=shared.sandbox(['/usr/bin/gpg','--batch','--no-options','--homedir',str(work/'home/gnupg'),
        '--with-colons','--show-keys',str(cache/'keyrings/ros.gpg')],work)
    shared.validate_ros_key(shown)
    for prefix,key,components in (
        ('archive.ubuntu.com_ubuntu_dists_noble','ubuntu.gpg',('main','universe')),
        ('archive.ubuntu.com_ubuntu_dists_noble-updates','ubuntu.gpg',('main','universe')),
        ('security.ubuntu.com_ubuntu_dists_noble-security','ubuntu.gpg',('main','universe')),
        ('snapshots.ros.org_jazzy_'+planner.SNAPSHOT+'_ubuntu_dists_noble','ros.gpg',('main',))):
        clear=planner.verified_release(cache/'lists'/(prefix+'_InRelease'),work,cache/'keyrings'/key,shared.sandbox)
        planner.verify_cached_packages(clear,cache,prefix,components)
    # Rebind every selected version/hash/size to those authenticated bytes.
    config=planner.apt_config(work/'apt',cache)
    rows=plan['packages']
    text=shared.sandbox(['/usr/bin/apt-cache','show',*[r['name']+'='+r['version'] for r in rows]],work,apt_config=config)
    if sorted(planner.package_rows(text,[(r['name'],r['version']) for r in rows]),key=lambda x:x['name'])!=rows:
        raise ValueError('exact signed package rows changed')
    return config


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args):raise ValueError('artifact redirect forbidden')


def download(recipe,root,work):
    config=verify_metadata(recipe['apt_plan'],work)
    archives=root/'.archives';archives.mkdir(mode=0o700)
    debs=archives/'debs';debs.mkdir(mode=0o700)
    shared.sandbox(['/usr/bin/env','HOME='+str(work/'home'),'TMPDIR='+str(work/'tmp'),
        '/usr/bin/apt-get','-o','APT::Get::Simulate=false','download',
        *[r['name']+'='+r['version'] for r in recipe['apt_plan']['packages']]],root,cwd=debs,apt_config=config)
    check_debs(recipe,debs)
    wheels=archives/'wheels';wheels.mkdir(mode=0o700)
    opener=build_opener(NoRedirect(),HTTPSHandler())
    for row in recipe['wheels']:
        target=wheels/row['filename'];digest=hashlib.sha256();size=0
        with opener.open(row['url'],timeout=30) as source,target.open('xb') as output:
            if source.status!=200:raise ValueError('wheel HTTP failure')
            for chunk in iter(lambda:source.read(1024*1024),b''):
                size+=len(chunk)
                if size>row['size']:raise ValueError('wheel exceeds lock size')
                digest.update(chunk);output.write(chunk)
            output.flush();os.fsync(output.fileno())
        if size!=row['size'] or digest.hexdigest()!=row['sha256']:raise ValueError('wheel hash/size mismatch')


def check_debs(recipe,directory):
    selected=validate_plan(recipe['apt_plan']);result={}
    for path in directory.iterdir():
        info=path.lstat()
        if not stat.S_ISREG(info.st_mode) or path.suffix!='.deb':raise ValueError('unexpected DEB archive entry')
        fields=shared.execute(['/usr/bin/dpkg-deb','-f',str(path),'Package','Version','Architecture']).splitlines()
        values=dict(line.split(': ',1) for line in fields)
        name=values['Package'];row=selected.get(name)
        if (row is None or name in result or values['Version']!=row['version'] or values['Architecture'] not in ('amd64','all')
                or info.st_size!=row['download_bytes'] or shared.sha(path)!=row['sha256']):
            raise ValueError('archive exact identity differs from signed plan')
        result[name]=path
    if set(result)!=set(selected):raise ValueError('incomplete archive set')
    return result


@contextmanager
def deb_stream(path,stage):
    with tempfile.TemporaryFile(dir=stage) as errors:
        child=subprocess.Popen(['/usr/bin/dpkg-deb','--fsys-tarfile',str(path)],stdout=subprocess.PIPE,stderr=errors)
        try:
            yield child.stdout
            child.stdout.close()
            if child.wait(timeout=60)!=0:raise ValueError('DEB payload inspection failed')
        finally:
            if child.poll() is None:child.kill();child.wait()
            child.stdout.close()


def install_wheels(recipe,root,tree):
    from .rootfs_config import inside
    expanded_total=0
    for row in recipe['wheels']:
        path=root/'.archives/wheels'/row['filename']
        if path.stat().st_size!=row['size'] or shared.sha(path)!=row['sha256']:raise ValueError('wheel changed')
        target=inside(tree,'/opt/foothold-sim/python-vendor' if wheel_name(row['name'])=='trimesh' else '/foothold-runtime/control')
        target.mkdir(parents=True,exist_ok=True)
        seen=set();total=0;metadata=[]
        with zipfile.ZipFile(path) as wheel:
            for item in wheel.infolist():
                key=archive.name(item.filename)
                if key in seen:raise ValueError('duplicate wheel member')
                seen.add(key);total+=item.file_size
                expanded_total+=item.file_size
                if total>512*1024**2 or expanded_total>2*1024**3 or len(seen)>50000 or stat.S_ISLNK(item.external_attr>>16):
                    raise ValueError('wheel exceeds envelope or contains link')
                if '.data' in key.split('/')[0]:raise ValueError('wheel installation scheme needs separate review')
                if item.is_dir():continue
                if key.endswith('.dist-info/METADATA'):
                    raw=wheel.read(item)
                    from email.parser import BytesParser
                    fields=BytesParser().parsebytes(raw)
                    if wheel_name(fields['Name'])!=wheel_name(row['name']) or fields['Version']!=row['version']:
                        raise ValueError('wheel metadata identity differs')
                    metadata.append(key)
                # ZIP and DEB payloads may not create symlink-parent writes.
                destination=inside(tree,'/'+str((target/key).relative_to(tree)))
                digest=hashlib.sha256()
                with wheel.open(item) as source:
                    for chunk in iter(lambda:source.read(1024*1024),b''):digest.update(chunk)
                fd=os.open(tree,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
                try:
                    with wheel.open(item) as source:
                        archive.put(fd,str(destination.relative_to(tree)),source,
                            dict(size=item.file_size,sha256=digest.hexdigest(),mode=0o444))
                finally:os.close(fd)
        if len(metadata)!=1:raise ValueError('wheel package metadata unproven')


def manifest_rows(root):
    return [row for row in shared.tree_manifest(root) if row['path'] not in CONTROL]


def seal(root,recipe_sha):
    # Rootfs bytes are immutable before recording actual content/modes/owners.
    shared.normalize(root)
    (root/'RECIPE.json').chmod(0o400)
    # Archive cache is retained, but is never readable by the dedicated UID.
    for p in [root/'.archives',*sorted((root/'.archives').rglob('*'))]:
        if not p.is_symlink():p.chmod(0o500 if p.is_dir() else 0o400)
    rows=manifest_rows(root)
    data=shared.canonical(dict(schema=1,recipe_sha256=recipe_sha,rows=rows))
    (root/'MANIFEST.json').write_bytes(data);(root/'MANIFEST.json').chmod(0o400)
    manifest_sha=hashlib.sha256(data).hexdigest()
    identity=dict(schema=1,recipe_sha256=recipe_sha,manifest_sha256=manifest_sha)
    (root/'foothold-runtime/identity.json').write_bytes(shared.canonical(identity))
    (root/'foothold-runtime/identity.json').chmod(0o444)
    complete=dict(**identity,identity_sha256=shared.sha(root/'foothold-runtime/identity.json'))
    (root/'COMPLETE.json').write_bytes(shared.canonical(complete));(root/'COMPLETE.json').chmod(0o400)
    root.chmod(0o555)
    verify(root,recipe_sha)
    return complete


def completion(root,recipe_sha):
    if not shared.HASH.fullmatch(recipe_sha) or root.name!=recipe_sha:raise ValueError('rootfs recipe path mismatch')
    recipe=private_json(root/'RECIPE.json',0o400)
    if digest(recipe)!=recipe_sha:raise ValueError('rootfs recipe hash mismatch')
    value=private_json(root/'COMPLETE.json',0o400)
    if (set(value)!={'schema','recipe_sha256','manifest_sha256','identity_sha256'} or value['schema']!=1
            or value['recipe_sha256']!=recipe_sha or not shared.HASH.fullmatch(value['manifest_sha256'])
            or shared.sha(root/'MANIFEST.json')!=value['manifest_sha256']
            or shared.sha(root/'foothold-runtime/identity.json')!=value['identity_sha256']):
        raise ValueError('rootfs completion/manifest mismatch')
    # Check 0400 without parsing the potentially large manifest on each proof.
    info=(root/'MANIFEST.json').lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o400:
        raise ValueError('rootfs actual manifest is not root-only 0400')
    return value


def verify(root,recipe_sha):
    info=root.lstat()
    if info.st_uid!=0 or info.st_gid!=0 or stat.S_IMODE(info.st_mode)!=0o555:
        raise ValueError('rootfs root must be root-owned read-only')
    value=completion(root,recipe_sha)
    manifest=json.loads((root/'MANIFEST.json').read_text())
    rows=manifest_rows(root)
    if manifest!={'schema':1,'recipe_sha256':recipe_sha,'rows':rows}:
        raise ValueError('rootfs actual manifest changed')
    for row in rows:
        # Linux symlink mode is 0777; its root-owned, read-only parent protects
        # replacement, while its exact target is bound by the manifest.
        if row['uid']!=0 or row['gid']!=0 or (row['type']!='link' and row['mode']&0o222) or row['mode']&0o7000:
            raise ValueError('rootfs mutable/privileged payload')
    return value


def build(recipe,root,work):
    debs=check_debs(recipe,root/'.archives/debs')
    from .verify_gz_abi import verify as abi
    abi(debs)
    rows={}
    for key,path in debs.items():
        with deb_stream(path,work) as stream:rows[key]=archive.scan(stream)
        for row in rows[key]:
            if row['path'].split('/')[0] in RESERVED:raise ValueError('archive replaces generated namespace')
    _,canonical=archive.graph(rows)
    if any(path.split('/')[0] in RESERVED for path in canonical):
        raise ValueError('canonical archive path replaces generated namespace')
    tree=work/'tree';tree.mkdir(mode=0o700)
    archive.merge(tree,rows,lambda key:deb_stream(debs[key],work))
    check_debs(recipe,root/'.archives/debs')  # archives unchanged across both passes
    install_wheels(recipe,root,tree)
    from .rootfs_config import generate
    generate(tree,recipe['config'],root.name)
    for child in tree.iterdir():
        if (root/child.name).exists() or (root/child.name).is_symlink():raise ValueError('generated payload collision')
        child.rename(root/child.name)
    shutil.rmtree(work)
    # Completion is written only after the final unchanged-host audit.


def audited(action,persist):
    before=shared.snapshot();pending=shared.create_install_latch();error=None
    try:action(before)
    except BaseException as caught:error=caught
    after=shared.snapshot()
    persist(before,after,error)  # after evidence precedes comparison, even on failure
    shared.verify_host_unchanged(before,after)
    if error is not None:raise error
    shared.clear_install_latch(pending)


def require_unsealed(root):
    # A completed (or partly sealed) recipe is not a transaction target. Do not
    # even append failure evidence there: it would invalidate the actual seal.
    fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        for name in ('COMPLETE.json','MANIFEST.json'):
            try:os.stat(name,dir_fd=fd,follow_symlinks=False)
            except FileNotFoundError:continue
            raise ValueError('rootfs already sealed; build refused without writes')
        if not stat.S_IMODE(os.fstat(fd).st_mode)&0o222:
            raise ValueError('rootfs already read-only; build refused without writes')
    finally:os.close(fd)


def run(operation,recipe_path,expected):
    os.umask(0o077)
    if os.geteuid()!=0:raise ValueError('server root only')
    recipe=private_json(recipe_path);recipe_sha=validate_recipe(recipe)
    if recipe_sha!=expected or not shared.HASH.fullmatch(expected):raise ValueError('explicit recipe SHA required')
    shared.ensure_no_install_latch()
    with planner.DEPLOY_LOCK.open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if planner.GUARD.exists() or planner.GUARD.is_symlink():raise ValueError('initial build requires no activated guard')
        shared.ROOT.lstat();ROOT.mkdir(mode=0o700,exist_ok=True)
        for parent in (ROOT,*ROOT.parents):
            info=parent.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise ValueError('untrusted rootfs parent')
        if shutil.disk_usage(ROOT).free<20*1024**3:raise ValueError('20GiB free envelope required')
        root=ROOT/recipe_sha
        if operation=='download' and (root.exists() or root.is_symlink()):raise ValueError('recipe exists; no automatic retry')
        if operation!='download' and (not root.is_dir() or root.is_symlink()):raise ValueError('rootfs recipe directory absent')
        if operation=='build':require_unsealed(root)
        work=root/'.stage'
        def action(before):
            # Every write, download, scratch file and evidence stays within recipe SHA.
            if operation=='download':
                root.mkdir(mode=0o700);(root/'RECIPE.json').write_bytes(shared.canonical(recipe));(root/'RECIPE.json').chmod(0o400)
            if digest(private_json(root/'RECIPE.json',0o400))!=recipe_sha:raise ValueError('stored recipe changed')
            work.mkdir(mode=0o700)
            (work/'before.json').write_bytes(shared.canonical(before))
            if operation=='download':download(recipe,root,work)
            elif operation=='build':
                # Move audit to root-private cache before build removes scratch.
                archive_dir=root/'.archives/audit';archive_dir.mkdir(mode=0o700)
                (archive_dir/'build-before.json').write_bytes(shared.canonical(before))
                build(recipe,root,work)
            else:raise ValueError('invalid rootfs operation')
        def persist(before,after,error):
            evidence=root/'.archives' if (root/'.archives').is_dir() else root
            (evidence/(operation+'-after.json')).write_bytes(shared.canonical(after))
            if error is not None:
                details=dict(type=type(error).__name__)
                if type(error) is ValueError:details['reason']=str(error)
                (evidence/(operation+'-error.json')).write_bytes(shared.canonical(details))
                return
            # Verify host identity before making a completion marker.
            shared.verify_host_unchanged(before,after)
            if operation=='download':
                (root/'.archives/download-before.json').write_bytes(shared.canonical(before));shutil.rmtree(work)
            else:seal(root,recipe_sha)
        audited(action,persist)
        print('Rootfs '+operation+' complete recipe='+recipe_sha+' host_unchanged=true; runtime not activated')


if __name__=='__main__':
    try:
        parser=argparse.ArgumentParser(description=__doc__)
        parser.add_argument('operation',choices=('download','build'))
        parser.add_argument('recipe',type=Path);parser.add_argument('recipe_sha256')
        args=parser.parse_args()
        # Bound the inspector itself; never increase a pre-existing lower limit.
        for option,ceiling in ((resource.RLIMIT_AS,2*1024**3),(resource.RLIMIT_CPU,3600)):
            soft,hard=resource.getrlimit(option)
            bounded=lambda value:ceiling if value==resource.RLIM_INFINITY else min(value,ceiling)
            resource.setrlimit(option,(bounded(soft),bounded(hard)))
        run(args.operation,args.recipe,args.recipe_sha256)
    except BaseException as error:
        if isinstance(error,SystemExit) and error.code in (0,None):raise
        raise SystemExit('Rootfs build refused; retain recipe/latch/evidence and escalate') from None
