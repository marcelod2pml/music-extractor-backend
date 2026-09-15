FROM node:20-alpine

# Instala dependências do sistema: Python, FFmpeg, pip e quickjs (JS runtime ultrarrápido)
RUN apk add --no-cache python3 py3-pip ffmpeg quickjs

# Instala yt-dlp e yt-dlp-ejs (provedor oficial de scripts para desafios JS do YouTube)
RUN pip3 install --no-cache-dir --break-system-packages yt-dlp yt-dlp-ejs

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3333

CMD ["node", "src/server.js"]
