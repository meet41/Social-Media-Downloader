# Force cache bust v2
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    git \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --break-system-packages --upgrade "yt-dlp[default]@git+https://github.com/yt-dlp/yt-dlp.git" pycryptodomex

WORKDIR /app

COPY package*.json ./
RUN npm install --production

# Install Playwright browser and dependencies
RUN npx playwright install --with-deps chromium

COPY . .

EXPOSE 3001

CMD ["node", "index.js"]
