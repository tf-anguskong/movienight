FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    vainfo \
    intel-media-va-driver-non-free \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY src/ ./src/

RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "src/server.js"]
