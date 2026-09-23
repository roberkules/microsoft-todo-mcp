ARG NODE_VERSION=24.21.0
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY tsconfig.json tsup.config.ts ./
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:${NODE_VERSION}-bookworm-slim
ENV NODE_ENV=production MS_TODO_TOKEN_CACHE=/data/token-cache.json
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir /data && chown node:node /data && chmod 700 /data
USER node
EXPOSE 8000
ENTRYPOINT ["node", "dist/index.js"]
CMD ["serve", "--http"]
