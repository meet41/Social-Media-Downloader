FROM node:20-bullseye-slim

# Install system dependencies: python3 and ffmpeg
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip ffmpeg curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install
COPY package*.json ./
RUN npm install --production

# Copy application files
COPY . .

# Set PORT environment variable
ENV PORT=3001
EXPOSE 3001

CMD ["node", "index.js"]
