"""Bounded metadata persistence, independent of agent input and safety history."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import partial

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from .robots import save_inventory


@dataclass
class PendingInventory:
    pending: tuple | None = None
    saved: tuple | None = None
    running: tuple | None = None
    running_generation: int | None = None
    task: asyncio.Task | None = None
    retry_at: float = 0
    retired: bool = False
    model: str | None = None
    token_hash: bytes | None = None
    generation: int = 0
    attempted: tuple | None = None
    attempts: int = 0
    exhausted: tuple | None = None


class InventoryWriter:
    MAX_ATTEMPTS = 3
    RETRY_DELAY = 1

    def __init__(self, settings, clock, failed):
        self.settings, self.clock, self.failed = settings, clock, failed
        self.engine = create_engine(settings.database_url, pool_size=2, max_overflow=0,
            pool_timeout=1, connect_args={'options': '-c lock_timeout=1000 -c statement_timeout=2000',
                                         'connect_timeout': 2})
        self.factory = sessionmaker(self.engine, expire_on_commit=False)
        self.executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix='fh-inventory')
        self.slots = asyncio.Semaphore(2)
        self.jobs = {}
        self.closing = False

    def submit(self, rid, devices, model, token_hash):
        if self.closing:
            return
        # The wire frame caps inventory size. Each connected robot has at most
        # one running write and one replaceable latest snapshot, never a FIFO.
        job = self.jobs.setdefault(rid, PendingInventory())
        if token_hash != job.token_hash:
            job.generation += 1
            job.token_hash, job.model = token_hash, None
            job.pending = job.saved = job.exhausted = job.attempted = None
            job.attempts, job.retry_at = 0, 0
        if model is not None:
            job.model = model
        value = (tuple(sorted(tuple(sorted(d.items())) for d in devices)), job.model, token_hash)
        job.retired = False
        if value == job.exhausted:
            return
        if value == job.pending or (job.pending is None and value == job.running
                                    and job.running_generation == job.generation):
            return
        if job.running is None and job.pending is None and value == job.saved:
            return
        job.pending = value
        job.exhausted = None
        if job.task is None or job.task.done():
            job.task = asyncio.create_task(self.write(rid, job))

    async def write(self, rid, job):
        try:
            while job.pending is not None and not self.closing:
                if self.clock() < job.retry_at:
                    await asyncio.sleep(job.retry_at - self.clock())
                if self.closing or job.pending is None:
                    break
                async with self.slots:
                    if job.pending is None:
                        break
                    value, job.pending = job.pending, None
                    job.running = value
                    generation = job.generation
                    job.running_generation = generation
                    if job.attempted != value:
                        job.attempted, job.attempts = value, 0
                    job.attempts += 1
                    devices, model, token_hash = value
                    try:
                        await asyncio.get_running_loop().run_in_executor(self.executor,
                            partial(save_inventory, self.factory, self.settings.org_id, rid,
                                [dict(d) for d in devices], model, token_hash))
                        if generation == job.generation and not job.retired:
                            job.saved = value
                            job.attempted, job.attempts = None, 0
                    except Exception as exc:
                        if generation == job.generation and not job.retired and not self.closing:
                            job.retry_at = self.clock() + self.RETRY_DELAY
                            if job.pending is None:
                                if job.attempts < self.MAX_ATTEMPTS:
                                    job.pending = value
                                else:
                                    job.exhausted = value
                        # Metadata storage failure never retires an agent or
                        # blocks STOP confirmation, ping or telemetry reception.
                        self.failed(rid, type(exc).__name__)
                    finally:
                        job.running = None
                        job.running_generation = None
        finally:
            job.task = None
            if job.retired and self.jobs.get(rid) is job:
                self.jobs.pop(rid)
            if self.closing:
                job.pending = None

    def forget(self, rid):
        job = self.jobs.get(rid)
        if job:
            job.pending, job.retired = None, True
            job.generation += 1
            job.token_hash = job.model = job.saved = None
            job.exhausted = job.attempted = None
            job.attempts, job.retry_at = 0, 0
            if job.task is None:
                self.jobs.pop(rid)

    async def close(self):
        self.closing = True
        for job in self.jobs.values():
            job.pending = None
        await asyncio.gather(*(j.task for j in self.jobs.values() if j.task), return_exceptions=True)
        await asyncio.to_thread(self.executor.shutdown, wait=True, cancel_futures=True)
        self.engine.dispose()
        self.jobs.clear()
