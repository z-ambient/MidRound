# MidRound production image.
FROM node:26-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js db.js faceit.js rate-limit.js validate.js ./
COPY public ./public

# Run as the non-root "node" user (built into the base image) so a
# compromised app process doesn't own the container. Code stays root-owned
# (read-only to the app); only /data — where the SQLite database lives — is
# writable. Mount a volume at /data to persist it across deploys.
RUN mkdir /data && chown node /data
USER node
ENV MIDROUND_DB_PATH=/data/midround.db
# production = no demo-org seeding (8 well-known accounts) on first boot
ENV NODE_ENV=production

# Behind a platform proxy set TRUSTED_PROXY_HOPS=1 (and COOKIE_SECURE=1 if
# the proxy doesn't send X-Forwarded-Proto) in the deployment environment.
EXPOSE 4310
CMD ["node", "server.js"]
