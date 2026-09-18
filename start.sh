#!/bin/sh
set -e

# bgutil-pot (PO Token provider) se quito de aqui: el plugin de yt-dlp que
# lo consultaria nunca se cargo ("Plugin directories: none" en los logs),
# asi que estaba corriendo 24/7 sin usarse. Cuando de verdad se necesite
# (por ahora no: cookies + Deno + player_client=web son suficientes),
# volver a agregar la linea del binario aqui.

exec node server.js