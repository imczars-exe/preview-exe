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
    && pip3 install --no-cache-dir --break-system-packages -U yt-dlp \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# bgutil-pot: genera el PO Token que YouTube exige ahora ademas de las
# cookies para trafico de datacenter. Es un binario Rust standalone que
# corre como servidor HTTP local (puerto 4416); el plugin de yt-dlp lo
# consulta automaticamente. https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs
RUN curl -L https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs/releases/latest/download/bgutil-pot-linux-x86_64 \
      -o /usr/local/bin/bgutil-pot \
    && chmod +x /usr/local/bin/bgutil-pot \
    && mkdir -p /app/yt-dlp-plugins \
    && curl -L https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs/releases/latest/download/bgutil-ytdlp-pot-provider-rs.zip \
      -o /tmp/bgutil-plugin.zip \
    && unzip -q /tmp/bgutil-plugin.zip -d /app/yt-dlp-plugins \
    && rm /tmp/bgutil-plugin.zip

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Railway/Render inject PORT at runtime; 3939 is just the local fallback.
ENV PORT=3939
EXPOSE 3939

RUN chmod +x start.sh

CMD ["./start.sh"]