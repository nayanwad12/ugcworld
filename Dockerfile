FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
# System FFmpeg (has xfade for crossfades) + Noto fonts so captions render Hindi, Arabic, Tamil, etc.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-noto-core ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace server --include-workspace-root=false
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
COPY shared shared
VOLUME /data
EXPOSE 8787
CMD ["node", "server/dist/index.js"]
