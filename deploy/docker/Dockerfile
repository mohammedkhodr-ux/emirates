# syntax=docker/dockerfile:1.7
FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
ENV HOST=0.0.0.0 \
    PORT=3000
EXPOSE 3000
USER node
HEALTHCHECK --interval=10s --timeout=5s --retries=5 --start-period=10s \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
