FROM node:20-bookworm-slim

# Install system dependencies: python3, pip, ffmpeg, curl
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv \
        ffmpeg curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install latest yt-dlp binary globally
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm install --omit=dev 2>/dev/null || (npm init -y && npm install express cors)

# Copy backend application files
COPY . .

ENV PORT=3001
ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "index.js"]
