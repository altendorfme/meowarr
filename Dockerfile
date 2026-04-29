FROM --platform=$BUILDPLATFORM node:22-alpine AS deps

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci


FROM node:22-alpine AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json Gruntfile.js ./
COPY src ./src
COPY public ./public
COPY views ./views
COPY scripts ./scripts

RUN npx grunt build && npm prune --omit=dev


FROM node:22-alpine AS runtime

RUN apk add --no-cache git tini tzdata su-exec \
 && addgroup -S app && adduser -S app -G app \
 && mkdir -p /app/data && chown -R app:app /app

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=9797 \
    DATA_DIR=/app/data \
    NODE_OPTIONS=--max-old-space-size=4096

COPY --chown=app:app --from=builder /app/node_modules ./node_modules
COPY --chown=app:app --from=builder /app/public/dist ./public/dist
COPY --chown=app:app package*.json ./
COPY --chown=app:app src ./src
COPY --chown=app:app views ./views
COPY --chown=app:app public/favicon.svg ./public/favicon.svg
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

VOLUME ["/app/data"]
EXPOSE 9797

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||9797)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini","--","/usr/local/bin/docker-entrypoint.sh"]
CMD ["node","src/server.js"]
