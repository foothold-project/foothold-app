"""Issuer mutations in disposable worktree-local copies, with assertion-only kills."""
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[3]
MUTATIONS=[
    ('one phone one robot removed', 'if blocked:', 'if False:',
     'test_one_phone_one_robot_requires_explicit_switch_and_every_ack'),
    ('issuance rate limit removed', 'if len(recent) >= 10:', 'if False:',
     'test_issuer_limits_persist_across_sessions_and_device_slots'),
    ('switch allowed without ack', 'PhoneRevocation.acked_at.is_not(None)', 'PhoneRevocation.acked_at.is_(None)',
     'test_one_phone_one_robot_requires_explicit_switch_and_every_ack'),
]


def main():
    available=next(int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines()
                   if line.startswith('MemAvailable:'))
    if available<2500000:
        raise SystemExit('MemAvailable below2.5GB')
    temp=ROOT/'tmp'/'phone-pass-mutations';temp.mkdir(parents=True,exist_ok=True)
    pgtemp=ROOT/'tmp'/'ppg'; pgtemp.mkdir(parents=True,exist_ok=True)
    failed=False
    for label,before,after,test in MUTATIONS:
        with tempfile.TemporaryDirectory(dir=temp,prefix='mutant-') as folder:
            dest=Path(folder)
            shutil.copytree(ROOT/'apps'/'server',dest/'apps'/'server',ignore=shutil.ignore_patterns('__pycache__'))
            shutil.copytree(ROOT/'apps'/'contracts',dest/'apps'/'contracts',ignore=shutil.ignore_patterns('__pycache__','node_modules'))
            shutil.copytree(ROOT/'apps'/'agent'/'foothold_agent',dest/'apps'/'agent'/'foothold_agent',ignore=shutil.ignore_patterns('__pycache__'))
            shutil.copyfile(ROOT/'apps'/'agent'/'tools'/'mutation_reporter.py',dest/'foothold_link_mutation_probe.py')
            source=dest/'apps'/'server'/'fh_server'/'phone_pass.py'
            original=source.read_text()
            if original.count(before)!=1: raise RuntimeError('nonunique anchor: '+label)
            source.write_text(original.replace(before,after))
            report=dest/'report.json'
            result=subprocess.run([sys.executable,'-m','pytest','apps/server/tests/test_phone_pass.py::'+test,
                '-q','--tb=short','-p','foothold_link_mutation_probe','--link-mutation-report',str(report)],
                cwd=dest,env={**os.environ,'TMPDIR':str(pgtemp),'FH_TEST_PORT_RANGE':'9450:9469'},
                capture_output=True,text=True,timeout=90)
            data=json.loads(report.read_text()) if report.exists() else {}
            killed=result.returncode==1 and data.get('collected',0)>0 and bool(data.get('assertions')) and not data.get('errors')
            print(('KILLED' if killed else 'SURVIVED/ERROR')+' | '+label,flush=True)
            if not killed:
                failed=True;print(result.stdout[-2500:]+result.stderr[-500:])
    return int(failed)


if __name__=='__main__': raise SystemExit(main())
