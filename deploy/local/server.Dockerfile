# 로컬 compose 의 init · server 이미지. 운영과 같은 Python 3.12 · 같은 requirements.
FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY apps/server/requirements.txt apps/server/requirements.txt
RUN pip install --no-cache-dir -r apps/server/requirements.txt
# 서버가 쓰는 것만 (apps.server · apps.contracts · simmgr 세계 목록) 과 init 스크립트
COPY apps/server apps/server
COPY apps/contracts apps/contracts
# sim_maps.py (마이그레이션 0028 · 서버 시작) 가 읽는 Gazebo 세계 목록
COPY apps/simmgr/worlds apps/simmgr/worlds
COPY deploy/local/init_db.py deploy/local/init_db.py
RUN useradd --system --uid 10001 foothold && mkdir -p /var/lib/foothold/files \
    && chown foothold /var/lib/foothold/files
USER foothold
