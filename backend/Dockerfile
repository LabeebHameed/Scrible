# Scrible backend — self-contained: this directory has no cross-workspace
# dependencies, so the build context is `backend/` itself (not the monorepo root).
# Runs via tsx (matches `npm start`, no separate build/emit step).
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY src ./src
COPY tsconfig.json ./

ENV NODE_ENV=production
EXPOSE 8787
CMD ["npx", "tsx", "src/index.ts"]
