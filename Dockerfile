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
#
# chmod first, because COPY preserves the build context's file modes and the
# context is whatever the host filesystem hands over. A repo cloned onto a
# dataset with a restrictive umask or ACL - a TrueNAS pool, say - arrives
# readable only by root. Running as root hid that; running as `node` turns it
# into a container that cannot even read server.js to start. Normalising the
# tree makes the image behave the same wherever it was built.
#
# The data directory is then chowned so a *named* volume inherits that
# ownership on first use. A host bind mount keeps the host's ownership instead
# - see the note in docker-compose.yml if you need one.
RUN chmod -R a+rX /app && \
    mkdir -p /app/data && \
    chown -R node:node /app/data
USER node

ENV PORT=4173
EXPOSE 4173
VOLUME ["/app/data"]
CMD ["node", "server.js"]
