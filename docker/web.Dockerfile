FROM node:22-bookworm-slim
WORKDIR /workspace/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --ignore-scripts
EXPOSE 5180
# 마운트된 lockfile이 바뀌었어도 volume의 의존성을 현재 소스에 맞춘다.
CMD ["sh", "-c", "npm ci --ignore-scripts && exec npm run dev"]
