FROM node:22-bookworm-slim
# prepare_sim.py (stdlib only) prepares /sim/ from the read-only asset mount at start.
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --ignore-scripts
COPY docker/web-start.sh /usr/local/bin/fh-web-start
EXPOSE 5180
CMD ["sh", "/usr/local/bin/fh-web-start"]
