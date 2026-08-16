FROM node:20-bookworm-slim

# Install system dependencies: python3, pip, ffmpeg, curl, git, chromium (for POT provider)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv python3-setuptools \
        ffmpeg curl ca-certificates git \
        chromium && \
    rm -rf /var/lib/apt/lists/*

# Install yt-dlp + POT plugin via pip (in a venv to avoid externally-managed error)
RUN python3 -m venv /opt/ytdlp-venv && \
    /opt/ytdlp-venv/bin/pip install --no-cache-dir yt-dlp bgutil-ytdlp-pot-provider && \
    ln -s /opt/ytdlp-venv/bin/yt-dlp /usr/local/bin/yt-dlp

# Clone and build the bgutil POT provider HTTP server
RUN git clone https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/pot-provider && \
    cd /opt/pot-provider/server && \
    npm ci && \
    npx tsc

# Set Chromium path for the POT provider (puppeteer)
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app

# Install Node.js packages for the backend
COPY package*.json ./
RUN npm install --omit=dev 2>/dev/null || (npm init -y && npm install express cors)

# Copy backend code
COPY . .

# Create startup script that launches the POT server + Node backend
RUN printf '#!/bin/bash\n\
echo "Starting POT provider server on port 4416..."\n\
cd /opt/pot-provider/server && node build/main.js &\n\
sleep 2\n\
echo "Starting Node.js backend..."\n\
cd /app && exec node index.js\n' > /app/start.sh && chmod +x /app/start.sh

ENV PORT=3001
ENV NODE_ENV=production
EXPOSE 3001

CMD ["/app/start.sh"]
