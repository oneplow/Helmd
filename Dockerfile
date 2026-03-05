FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN apk add --no-cache docker docker-cli-compose && npm install --production

COPY src/ ./src/

# Data directory for config (API key hash)
VOLUME /data

ENV NODE_ENV=production
ENV HELMD_PORT=9117
ENV HELMD_DATA_DIR=/data

EXPOSE 9117

CMD ["node", "src/index.js"]
