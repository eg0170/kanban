# better-sqlite3 is a native module, so use the full image which ships build tools.
FROM node:22-bookworm-slim

WORKDIR /app

# Build deps for compiling better-sqlite3, removed after install to keep image lean.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Copy the lockfile too and use `npm ci` so builds install the EXACT pinned
# dependency versions (reproducible, tamper-evident) rather than re-resolving.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && apt-get purge -y python3 make g++ && apt-get autoremove -y

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/kanban.db

EXPOSE 3000
VOLUME ["/data"]

CMD ["node", "server.js"]
