"""Offline complete build/seal check with existing fakeroot, never host root.

No downloads, package scripts, payload execution, host audits/latches or units.
The real kernel UID must be nonzero. fakeroot supplies ownership/permission
metadata only; this result cannot authorize a server install or runtime launch.
"""
import argparse
import json
import os
import resource
from pathlib import Path
import shutil
import stat
import tempfile
import time

from . import rootfs_build as build


def kernel_uid():
    for line in Path('/proc/self/status').read_text().splitlines():
        if line.startswith('Uid:'):return int(line.split()[2])
    raise ValueError('kernel UID unavailable')


def check(recipe_path,expected,debs,wheels,work_parent,report):
    actual_uid=kernel_uid()
    if actual_uid==0 or os.geteuid()!=0 or not os.environ.get('FAKEROOTKEY'):
        raise ValueError('run only as an unprivileged user under existing fakeroot')
    os.umask(0o077)
    for option,ceiling in ((resource.RLIMIT_AS,2*1024**3),(resource.RLIMIT_CPU,3600)):
        soft,hard=resource.getrlimit(option)
        bounded=lambda value:ceiling if value==resource.RLIM_INFINITY else min(value,ceiling)
        resource.setrlimit(option,(bounded(soft),bounded(hard)))
    recipe=json.loads(recipe_path.read_bytes())
    if build.validate_recipe(recipe)!=expected:raise ValueError('explicit current recipe SHA required')
    build.private_parents(work_parent/'scratch')
    if shutil.disk_usage(work_parent).free<6*1024**3:raise ValueError('6GiB private local scratch required')
    source_debs=build.check_debs(recipe,debs)
    if {p.name for p in wheels.iterdir()}!={r['filename'] for r in recipe['wheels']}:
        raise ValueError('exact offline wheel set required')
    start=time.monotonic();result=dict(schema=1,runnable=False,kernel_uid=actual_uid,
        ownership_model='fakeroot ownership/permission metadata (no real root privileges)',recipe_sha256=expected,
        address_space_limit=resource.getrlimit(resource.RLIMIT_AS)[0],cpu_seconds_limit=resource.getrlimit(resource.RLIMIT_CPU)[0],
        packages=len(source_debs),wheels=len(recipe['wheels']),server_actions=0)
    try:
        with tempfile.TemporaryDirectory(prefix='rootfs-preflight-',dir=work_parent) as folder:
            root=Path(folder)/expected;root.mkdir(mode=0o700)
            archive=root/'.archives';(archive/'debs').mkdir(parents=True);(archive/'wheels').mkdir()
            (root/'RECIPE.json').write_bytes(build.shared.canonical(recipe));(root/'RECIPE.json').chmod(0o400)
            for path in source_debs.values():shutil.copyfile(path,archive/'debs'/path.name)
            for row in recipe['wheels']:
                path=wheels/row['filename'];info=path.lstat()
                if (not stat.S_ISREG(info.st_mode) or info.st_size!=row['size']
                        or build.shared.sha(path)!=row['sha256']):raise ValueError('offline wheel differs from lock')
                shutil.copyfile(path,archive/'wheels'/path.name)
            work=root/'.stage';work.mkdir(mode=0o700)
            build.build(recipe,root,work)  # real scan/graph/merge/wheels/generator/publication
            complete=build.seal(root,expected)  # real normalize/manifest/seal/verification
            verified=build.verify(root,expected)
            if verified!=complete:raise ValueError('offline completion differs')
            manifest=json.loads((root/'MANIFEST.json').read_bytes())
            result.update(ok=True,complete=complete,manifest_rows=len(manifest['rows']),
                retained_archives=len(list((archive/'debs').iterdir())),stage_absent=not work.exists(),
                generators=recipe['generators'])
    except BaseException as error:
        result.update(ok=False,error=type(error).__name__,reason=str(error));raise
    finally:
        result['elapsed_seconds']=round(time.monotonic()-start,1)
        result['max_rss_kib']=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        report.write_text(json.dumps(result,sort_keys=True,indent=2))
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('recipe',type=Path);parser.add_argument('recipe_sha256')
    parser.add_argument('--debs',required=True,type=Path);parser.add_argument('--wheels',required=True,type=Path)
    parser.add_argument('--work-parent',required=True,type=Path);parser.add_argument('--report',required=True,type=Path)
    args=parser.parse_args()
    try:result=check(args.recipe,args.recipe_sha256,args.debs,args.wheels,args.work_parent,args.report)
    except BaseException as error:raise SystemExit('Offline preflight failed: '+str(error)) from None
    print(json.dumps({key:result[key] for key in ('ok','runnable','packages','wheels','manifest_rows','elapsed_seconds')}))


if __name__=='__main__':main()
