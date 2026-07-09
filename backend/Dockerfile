# Scrible backend — runs via tsx (no separate build/emit step), matching `npm start`.
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
RUN npm ci --workspace=backend --include-workspace-root --include=dev

COPY backend/src ./backend/src
COPY backend/tsconfig.json ./backend/tsconfig.json

ENV NODE_ENV=production
EXPOSE 8787
CMD ["npx", "tsx", "backend/src/index.ts"]
