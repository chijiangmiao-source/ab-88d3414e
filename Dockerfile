# 零依赖 Node 20 运行时镜像
FROM node:20-alpine

WORKDIR /app

# 无需 npm install —— 全部使用 Node 内置模块
COPY package.json ./
COPY src ./src
COPY public ./public
COPY test ./test
COPY scripts ./scripts

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=5s --timeout=3s --start-period=3s --retries=10 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/node/server.js"]
