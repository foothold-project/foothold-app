"""Focused reseal safety mutations: disposable deploy copies, no runtime/socket."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
A = 'deploy/asset_reseal.py'
T = 'deploy/tests/test_asset_reseal.py::'
MUTATIONS = [
    ('wrong mesh bytes accepted', A,
     "if len(body) != pin['size'] or digest(body) != pin['sha256']:", 'if False:',
     T+'test_private_source_pins_and_nofollow_before_mutation[different_bytes]'),
    ('mesh symlink followed', A,
     'os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC',
     'os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC',
     T+'test_private_source_pins_and_nofollow_before_mutation[symlink]'),
    ('old proof relabelled as new asset proof', A,
     'proof = rt.probe_evidence(candidate)',
     "proof = dict(rt.validated(data), asset_manifest_sha256=candidate['asset_manifest_sha256'])",
     T+'test_complete_reseal_preserves_old_tree_and_can_restore_binding_pair'),
    ('second replacement failure not rolled back', A,
     "record['switch_error_type'] = type(error).__name__\n        restore_pair(path, record, docs)",
     "record['switch_error_type'] = type(error).__name__",
     T+'test_second_atomic_replace_failure_restores_both_original_documents'),
    ('validation not bound to asset manifest', 'deploy/rootfs_runtime.py',
     "            or value.get('asset_manifest_sha256')!=data['asset_manifest_sha256']\n", '',
     T+'test_new_validation_is_asset_bound_not_just_success_booleans'),
    ('foreign input file set accepted', A,
     "if json.loads(manifest) != pins or set(p.name for p in directory.iterdir()) != set(pins['files']) | {'INPUT.json'}:",
     'if False:', T+'test_private_source_pins_and_nofollow_before_mutation[wrong_robot]'),
    ('unrelated runtime pair overwritten', A,
     "if actual not in (docs['old-' + name], docs['new-' + name]):", 'if False:',
     T+'test_restore_never_overwrites_an_unrelated_runtime_change'),
    ('live namespace accepted', A, '    rt.inactive_namespace(data)  # Real UID/unit/cgroup/domain93/partition/DDS proof.',
     '    pass  # mutation', T+'test_unknown_live_namespace_cannot_reseal'),
    ('session cleanup latch ignored', A, 'if marker.exists() or marker.is_symlink():', 'if False:',
     T+'test_existing_fences_block_before_copy_or_probe[state/unproven]'),
]


def main():
    parent=ROOT/'tmp/asset-reseal-mutations';parent.mkdir(parents=True,exist_ok=True)
    results=[]
    for name,path,before,after,test in MUTATIONS:
        with tempfile.TemporaryDirectory(dir=parent) as directory:
            dest=Path(directory)
            shutil.copytree(ROOT/'deploy',dest/'deploy',ignore=shutil.ignore_patterns('__pycache__','.pytest_cache'))
            source=dest/path;body=source.read_text()
            if body.count(before)!=1:raise ValueError('nonunique mutation anchor: '+name)
            source.write_text(body.replace(before,after))
            shutil.copyfile(ROOT/'apps/agent/tools/mutation_reporter.py',dest/'mutation_probe.py')
            report=dest/'result.json'
            run=subprocess.run([sys.executable,'-m','pytest',test,'-q','--tb=short','-p','mutation_probe',
                '--link-mutation-report',str(report)],cwd=dest,env={**os.environ,'PYTHONPATH':str(dest)},
                text=True,capture_output=True,timeout=30)
            data=json.loads(report.read_text()) if report.exists() else {}
            killed=run.returncode==1 and data.get('collected',0)>0 and data.get('assertions') and not data.get('errors')
            row={'name':name,'result':'KILLED' if killed else 'SURVIVED/ERROR','assertions':len(data.get('assertions',[]))}
            results.append(row);print(json.dumps(row),flush=True)
            if not killed:print(run.stdout[-2500:]+run.stderr[-500:])
    (parent/'results.json').write_text(json.dumps(results,indent=2)+'\n')
    return int(any(r['result']!='KILLED' for r in results))


if __name__=='__main__':
    raise SystemExit(main())
