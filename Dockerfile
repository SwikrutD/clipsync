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
RUN mkdir -p /app/data
ENV PORT=4173
EXPOSE 4173
VOLUME ["/app/data"]
CMD ["node", "server.js"]
