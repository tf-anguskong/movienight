FROM node:20-slim

WORKDIR /app

RUN sed -i 's/^Components: main$/Components: main non-free/' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      intel-media-va-driver-non-free \
      vainfo \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY src/ ./src/

RUN npm prune --omit=dev

RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "src/server.js"]
