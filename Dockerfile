# ---- build stage: compile server + web bundle ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY web ./web
RUN npm run build && npm run web:build

# ---- runtime stage: production deps only ----
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist

ENV ICLAW_SERVER_HOST=0.0.0.0
ENV ICLAW_SERVER_PORT=3000
EXPOSE 3000
# SQLite + 微信凭证默认落在这里，请挂载持久卷
VOLUME /app/data

CMD ["node", "dist/server/index.js"]
