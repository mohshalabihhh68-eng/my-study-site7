# Playwright image — فيها Chromium + مكتبات النظام (مهم لحل Cloudflare على Railway)
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# البروكسي من السيرفر (مش direct للعميل — عشان CORS)
ENV CF_PROXY=1

COPY package.json ./
RUN npm install --omit=dev

COPY server.js thanawica.js cf_bypass.js ./
COPY thanawica_decrypt.wasm thanawica_cookies.txt ./
RUN mkdir -p data

EXPOSE 3000
CMD ["node", "server.js"]
