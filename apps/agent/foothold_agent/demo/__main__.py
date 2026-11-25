"""Demo agent command line. Nothing connects unless `run` is given a config.

  simulate SCENARIO [--hours H] [--report OUT.json]   offline fast-forward, no network
  index OUT.json TRACE.jsonl...                          build the joint replay library
  run SCENARIO --config DEMO.yaml --replay LIB.json [--speed S]
"""
import argparse
import asyncio
import json
import sys


def _simulate(args):
    from . import scenario as sc
    from .sim import Simulation
    scenario = sc.load(args.scenario)
    sim = Simulation(scenario)
    sim.step(min(scenario.duration_s, args.hours * 3600) if args.hours else scenario.duration_s)
    report = sim.schedule_report()
    report['robots'] = {rid: dict(soc=round(r.soc, 1), state=r.state, docked=r.docked)
                        for rid, r in sim.robots.items()}
    if args.report:
        with open(args.report, 'w', encoding='utf-8') as fh:
            json.dump(report, fh, ensure_ascii=False, indent=1)
    late = [i for i in report['items'] if i['delay_min']]
    print(f'{scenario.name}: {len(report["items"])} items, {len(late)} late, '
          f'{len(report["causes"])} cause records')
    for item in late:
        print(f'  {item["item"]}: +{item["delay_min"]} min ({item["delay_cause"]} {item["delay_event"]})')
    for rid, r in report['robots'].items():
        print(f'  {rid}: soc {r["soc"]} {r["state"]} docked={r["docked"]}')


def _index(args):
    from . import replay
    library = replay.index(args.traces)
    replay.write(library, args.out)
    print({k: len(v) for k, v in library['clips'].items()}, 'clips from', len(library['sources']), 'files')


def _run(args):
    from . import config, replay, scenario as sc
    from .adapter import Fleet, run
    scenario = sc.load(args.scenario)
    settings = config.load(args.config, [r.id for r in scenario.robots])
    library = replay.load(args.replay)

    async def main():
        fleet = Fleet(scenario, library, speed=args.speed)
        await run(fleet, settings)

    asyncio.run(main())


def main(argv=None):
    parser = argparse.ArgumentParser(prog='python3 -m foothold_agent.demo')
    sub = parser.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('simulate')
    p.add_argument('scenario')
    p.add_argument('--hours', type=float)
    p.add_argument('--report')
    p.set_defaults(func=_simulate)
    p = sub.add_parser('index')
    p.add_argument('out')
    p.add_argument('traces', nargs='+')
    p.set_defaults(func=_index)
    p = sub.add_parser('run')
    p.add_argument('scenario')
    p.add_argument('--config', required=True)
    p.add_argument('--replay', required=True)
    p.add_argument('--speed', type=float, default=1.0)
    p.set_defaults(func=_run)
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == '__main__':
    sys.exit(main())
