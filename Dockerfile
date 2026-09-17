FROM node:20-slim

# ffmpeg: audio conversion + thumbnail embedding
# python3/pip: needed to install yt-dlp
#
# YouTube changes often and breaks older yt-dlp versions (errors like
# "The page needs to be reloaded"). When that happens, bump CACHEBUST below
# by 1 and push — it forces this layer to reinstall the latest yt-dlp
# without needing a full "Clear build cache & deploy" on Render.
ARG CACHEBUST=1
RUN echo "cachebust=${CACHEBUST}" && \
    apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-pip ca-certificates \
    && pip3 install --no-cache-dir --break-system-packages -U yt-dlp \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Railway/Render inject PORT at runtime; 3939 is just the local fallback.
ENV PORT=3939
EXPOSE 3939

CMD ["node", "server.js"]
