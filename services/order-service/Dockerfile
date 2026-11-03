FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first, so this layer is cached until package*.json changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts

USER node
EXPOSE 5002
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5002/health || exit 1
CMD ["node", "src/server.js"]
