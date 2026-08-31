FROM node:20-alpine
WORKDIR /app

# scripts/ and public/ must be in place before install: the postinstall hook
# runs scripts/vendor.js, which copies the browser assets (socket.io, the QR
# generator, the webfonts) out of node_modules into public/vendor.
COPY package.json package-lock.json ./
COPY scripts ./scripts
COPY public ./public
RUN npm ci --omit=dev

COPY server.js ./

# Run as the unprivileged `node` user that the base image already provides.
# This process parses untrusted websocket frames from the open internet; there
# is no reason for it to be able to write anywhere but its own data directory.
# The directory is created and chowned here so that a *named* volume inherits
# that ownership on first use. A host bind mount keeps the host's ownership
# instead - see the note in docker-compose.yml if you need one.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

ENV PORT=4173
EXPOSE 4173
VOLUME ["/app/data"]
CMD ["node", "server.js"]
