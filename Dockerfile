FROM node:20-slim

WORKDIR /app

RUN sed -i 's/^Components: main$/Components: main non-free/' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      intel-media-va-driver-non-free \
      libmfx1 \
      vainfo \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY src/ ./src/

# Bundle mediasoup-client into a browser-ready IIFE, then drop devDeps
RUN npm run build && npm prune --omit=dev

RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "src/server.js"]
