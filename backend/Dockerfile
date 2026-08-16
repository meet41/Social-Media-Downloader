FROM node:20-bookworm-slim

# Install system dependencies: python3, ffmpeg, curl
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 ffmpeg curl ca-certificates && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package.json and install express + cors
COPY package*.json ./
RUN npm install --production

# Copy application files
COPY . .

ENV PORT=3001
ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "index.js"]
