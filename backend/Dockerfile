FROM node:20-bookworm-slim

# Install system dependencies: python3, pip, ffmpeg, curl
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip python3-setuptools ffmpeg curl ca-certificates && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Initialize fresh package.json and install only pure JS libraries
RUN npm init -y && \
    npm install express cors

# Copy backend code
COPY . .

ENV PORT=3001
ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "index.js"]
