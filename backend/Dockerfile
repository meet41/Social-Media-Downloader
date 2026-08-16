FROM node:20-bookworm-slim

# Install python3, pip, ffmpeg, certs & upgrade yt-dlp via pip
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip python3-venv ffmpeg curl ca-certificates && \
    python3 -m pip install --break-system-packages --upgrade --no-cache-dir pip yt-dlp && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm install --production

# Copy backend application files
COPY . .

ENV PORT=3001
ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "index.js"]
