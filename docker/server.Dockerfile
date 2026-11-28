FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /workspace
COPY apps/server/requirements.txt apps/server/requirements.txt
RUN pip install --no-cache-dir -r apps/server/requirements.txt
COPY apps/server apps/server
COPY apps/contracts apps/contracts
# Migration 0028 and legacy warehouse registration read this static catalogue.
COPY apps/simmgr/worlds apps/simmgr/worlds
COPY docker/__init__.py docker/server.py docker/seed.py docker/
EXPOSE 8810
CMD ["python", "-m", "docker.server"]
