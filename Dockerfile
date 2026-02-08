FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json* ./
RUN npm install
COPY client/ ./
RUN npm run build

FROM node:20-alpine AS server-build
WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm install --production

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_DRIVER=sqlite
ENV SQLITE_PATH=/data/ktrain.sqlite
ENV DB_RUNTIME_CONFIG_PATH=/data/runtime-db.json
ENV ADMIN_PIN=change-me

RUN addgroup -S app && adduser -S app -G app
COPY --from=server-build /app/server/node_modules ./server/node_modules
COPY server ./server
COPY --from=client-build /app/client/dist ./client/dist
RUN mkdir -p /data && chown -R app:app /app /data

USER app
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "server/index.js"]
