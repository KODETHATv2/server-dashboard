FROM node:22-alpine AS build
WORKDIR /web
COPY web/package.json ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY server/index.js ./
COPY --from=build /web/dist ./public
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --start-interval=2s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "index.js"]
