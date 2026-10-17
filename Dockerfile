FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --registry=https://registry.npmjs.org
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ARG YOUTUBE_CAPTIONS=0
COPY requirements-youtube.txt ./
RUN if [ "$YOUTUBE_CAPTIONS" = "1" ]; then apk add --no-cache python3 py3-pip && python3 -m venv /opt/youtube && /opt/youtube/bin/pip install --no-cache-dir -r requirements-youtube.txt; fi
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY scripts/youtube-captions.py ./scripts/youtube-captions.py
COPY scripts/youtube-transcribe.py ./scripts/youtube-transcribe.py
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 8787
CMD ["npm", "start"]
