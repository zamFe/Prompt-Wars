# Prompt Wars — the game server plus its static files.
FROM node:22-alpine

WORKDIR /app

# Dependencies first, so a code change does not re-install them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js build.js ./
COPY public ./public
COPY tools ./tools

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Run unprivileged; the node image ships a "node" user for exactly this.
USER node

CMD ["node", "server.js"]
