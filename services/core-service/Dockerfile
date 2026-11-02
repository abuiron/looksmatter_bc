FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first, so this layer is cached until package*.json changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
# Uploaded images are written here; mount a volume to keep them across restarts.
RUN mkdir -p uploads && chown node:node uploads

USER node
EXPOSE 5001
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5001/health || exit 1
CMD ["node", "src/server.js"]
