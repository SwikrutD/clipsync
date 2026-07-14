FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY public ./public
RUN mkdir -p /app/data
ENV PORT=4173
EXPOSE 4173
VOLUME ["/app/data"]
CMD ["node", "server.js"]
