FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY sessions.mjs server.mjs ./
ENV GAF_BIND=0.0.0.0
USER pwuser
EXPOSE 8765
CMD ["node", "server.mjs"]
