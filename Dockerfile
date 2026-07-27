FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY server.js ./
COPY public/ ./public/

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s \
  CMD node -e "require('http').get('http://localhost:3000/api/categories', r => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "server.js"]
