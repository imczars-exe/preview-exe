#!/bin/sh
set -e

# Levanta el proveedor de PO Token en localhost:4416, en segundo plano.
# Si este proceso muere, el contenedor sigue vivo pero yt-dlp volvera a
# fallar con el bot-check; revisa los logs de "bgutil-pot" si eso pasa.
/usr/local/bin/bgutil-pot server --host 127.0.0.1 --port 4416 &

# Da un segundo para que el servidor de PO Token levante antes de aceptar
# trafico real.
sleep 1

exec node server.js
