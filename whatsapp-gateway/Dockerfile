FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY whatsapp-gateway/package*.json ./
RUN npm ci --only=production

FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY whatsapp-gateway/package*.json ./
COPY whatsapp-gateway/src ./src
COPY whatsapp-gateway/.env.example ./.env.example

# Non-root user
RUN addgroup -S -g 1001 gateway && \
    adduser -S -u 1001 -G gateway gateway && \
    mkdir -p /app/sessions /app/media && \
    chown -R gateway:gateway /app

USER gateway
VOLUME ["/app/sessions", "/app/media"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s \
  CMD node -e "const r=require('node:http').request({hostname:'127.0.0.1',port:8787,path:'/health',timeout:5000},res=>{if(res.statusCode!==200)process.exit(1);res.on('data',()=>{});res.on('end',()=>process.exit(0))});r.on('error',()=>process.exit(1));r.end();"
CMD ["node", "src/index.js"]
