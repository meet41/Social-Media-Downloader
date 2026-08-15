FROM node:20-bullseye-slim

# Install system dependencies: python3, ffmpeg, and build utilities
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip ffmpeg curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install npm dependencies with standard install
RUN npm install

# Copy application files
COPY . .

# Set PORT environment variable
ENV PORT=3001
EXPOSE 3001

CMD ["node", "index.js"]
