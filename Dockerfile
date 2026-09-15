FROM node:20-alpine

# Instala dependências do sistema: Python, FFmpeg e pip
RUN apk add --no-cache python3 py3-pip ffmpeg

# Instala yt-dlp atualizado via pip
RUN pip3 install --no-cache-dir --break-system-packages yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3333

CMD ["node", "src/server.js"]
