FROM node:20-bookworm-slim

# Install system dependencies: python3, ffmpeg, curl
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip ffmpeg curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json ./

# Install npm dependencies without optional/failed prebuilds
RUN npm install --omit=optional --no-audit --no-fund

# Copy application code
COPY . .

ENV PORT=3001
EXPOSE 3001

CMD ["node", "index.js"]
