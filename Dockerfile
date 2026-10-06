# 클라우드 배포용 이미지 (Render, Fly.io, Railway, 일반 VPS 등)
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data TRUST_PROXY=1 UPDATE_ON_LAUNCH=0
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
