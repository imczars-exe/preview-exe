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
      ffmpeg python3 python3-pip ca-certificates curl unzip \
    && pip3 install --no-cache-dir --break-system-packages -U "yt-dlp[default]" \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Deno: runtime de JS que yt-dlp necesita desde nov-2025 para resolver los
# "n challenge" / firmas de YouTube. Sin esto, YouTube responde pero sin
# ningun formato descargable ("The page needs to be reloaded"). El extra
# [default] de arriba instala yt-dlp-ejs (los scripts que resuelven el
# challenge); Deno es el runtime que los ejecuta, y yt-dlp lo detecta solo
# si esta en el PATH. https://github.com/yt-dlp/yt-dlp/wiki/EJS
RUN curl -L https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip \
      -o /tmp/deno.zip \
    && unzip -q /tmp/deno.zip -d /usr/local/bin \
    && chmod +x /usr/local/bin/deno \
    && rm /tmp/deno.zip

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Railway/Render inject PORT at runtime; 3939 is just the local fallback.
ENV PORT=3939
EXPOSE 3939

RUN chmod +x start.sh

CMD ["./start.sh"]