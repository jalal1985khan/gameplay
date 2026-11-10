#!/usr/bin/env bash
# Sets up the Aviator Live Monitor on an Ubuntu server, from this folder. Safe to run again:
# every step checks what is already there.
#
#   sudo bash setup.sh
#   sudo bash setup.sh --domain monitor.example.com --email you@example.com
#
# What it does:
#   1. Checks the system (Ubuntu, memory, disk) and adds swap when memory is short.
#   2. Installs Node.js 22 (if missing or older), Google Chrome, a virtual screen (Xvfb),
#      VNC (x11vnc) and a browser VNC viewer (noVNC).
#   3. Creates the "monitor" system user that runs everything, and installs the app's packages.
#   4. Creates and starts four services, so everything comes back after a reboot.
#   5. Asks for the sign-in accounts (an admin, and optionally a view-only one).
#   6. With --domain: publishes the monitor at https://<domain> through nginx with a certificate.
#      An admin who signs in there can also open the game window; a viewer cannot.
#
# Nothing is opened to the internet unless --domain is given: the monitor, VNC and noVNC all
# listen on the server itself only, and are reached through an SSH tunnel.
set -euo pipefail

RUN_USER=monitor
NODE_MAJOR=22
PORT=4321
VNC_PORT=5900
NOVNC_PORT=6080
DISPLAY_NO=:1
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAIN=""
EMAIL=""
KEPT_DOMAIN=""

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)"; exit 1 ;;
  esac
done

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '    \033[33mnote\033[0m  %s\n' "$*"; }
die()  { printf '\n\033[31mStopped:\033[0m %s\n' "$*" >&2; exit 1; }
as_user() { sudo -u "$RUN_USER" -H "$@"; }

# ---------------------------------------------------------------- 1. checks
step "Checking the system"
[ "$(id -u)" -eq 0 ] || die "Run this with sudo:  sudo bash setup.sh"
[ -f "$APP_DIR/server.js" ] && [ -f "$APP_DIR/users.js" ] || die "Run this from the monitor's own folder (server.js and users.js were not found in $APP_DIR)."
. /etc/os-release 2>/dev/null || true
[ "${ID:-}" = "ubuntu" ] || [ "${ID:-}" = "debian" ] || die "This script is written for Ubuntu (found: ${PRETTY_NAME:-unknown})."
[ "$(dpkg --print-architecture)" = "amd64" ] || die "Google Chrome for Linux needs a 64-bit Intel/AMD server (found $(dpkg --print-architecture))."
ok "${PRETTY_NAME:-Ubuntu}, $(dpkg --print-architecture)"

case "$APP_DIR" in
  /var/www/*|/usr/share/nginx/*|/srv/www/*)
    die "This folder ($APP_DIR) is inside a web server's public folder, so its files (and later the saved game sign-in) could be downloaded by anyone. Move it first, for example:  mv '$APP_DIR' /opt/aviator-monitor" ;;
  /root|/root/*)
    die "This folder is under /root, which the '$RUN_USER' user cannot read. Move it first, for example:  mv '$APP_DIR' /opt/aviator-monitor" ;;
esac
if [ -n "$DOMAIN" ]; then
  [[ "$DOMAIN" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ ]] || die "'$DOMAIN' does not look like a domain name."
  [ -n "$EMAIL" ] || [ -d "/etc/letsencrypt/live/$DOMAIN" ] || die "Add --email you@example.com (the certificate authority sends expiry notices there)."
  DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')"
fi

free_mb=$(df -Pm "$APP_DIR" | awk 'NR==2 {print $4}')
mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
swap_mb=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
ok "Memory ${mem_mb} MB, swap ${swap_mb} MB, free disk ${free_mb} MB"
[ "$free_mb" -ge 1500 ] || die "Only ${free_mb} MB of disk is free. Chrome and the other packages need about 1.5 GB. Free some space and run this again (see what is big:  sudo du -xh / --max-depth=2 | sort -h | tail -15)."

# Chrome with a live game does not fit in 1 GB of memory: add swap when there is room for it.
if [ "$mem_mb" -lt 1900 ] && [ "$swap_mb" -lt 1000 ]; then
  if [ "$free_mb" -ge 4500 ] && [ ! -e /swapfile ]; then
    fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ok "Added 2 GB of swap (memory is only ${mem_mb} MB)"
  else
    warn "Memory is only ${mem_mb} MB and there is no room for swap. Chrome may be stopped by the system once the game loads; a 2 GB server is the reliable fix."
  fi
fi

# ---------------------------------------------------------------- 2. packages
step "Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg xvfb x11vnc novnc websockify >/dev/null
ok "Virtual screen, VNC and noVNC"

node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt "$NODE_MAJOR" ]; then
  warn "Node.js $(node -v 2>/dev/null || echo 'is not installed'); installing version $NODE_MAJOR"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
[ "$(node_major)" -ge "$NODE_MAJOR" ] || die "Node.js $NODE_MAJOR or newer could not be installed (found $(node -v 2>/dev/null || echo none))."
NODE_BIN="$(command -v node)"
ok "Node.js $(node -v) at $NODE_BIN"

if ! command -v google-chrome >/dev/null 2>&1 && ! command -v google-chrome-stable >/dev/null 2>&1; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/chrome.deb" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y -qq "$tmp/chrome.deb" >/dev/null
  rm -rf "$tmp"
fi
ok "$(google-chrome --version 2>/dev/null || google-chrome-stable --version)"

for bin in Xvfb x11vnc websockify; do command -v "$bin" >/dev/null || die "$bin was not installed."; done
[ -f /usr/share/novnc/vnc.html ] || die "noVNC was not installed (/usr/share/novnc/vnc.html is missing)."

# ---------------------------------------------------------------- 3. user and app
step "Preparing the '$RUN_USER' user and the app"
if id "$RUN_USER" >/dev/null 2>&1; then
  ok "User '$RUN_USER' exists"
else
  useradd --create-home --shell /bin/bash "$RUN_USER"
  ok "Created user '$RUN_USER' (no password: it only runs the services)"
fi
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR"
as_user test -r "$APP_DIR/server.js" || die "The '$RUN_USER' user cannot read $APP_DIR. Move the folder somewhere it can reach, for example /opt/aviator-monitor or /home/$RUN_USER."
chmod 700 "$APP_DIR"   # Holds the saved game sign-in and the accounts: no other user reads it.
ok "$APP_DIR belongs to '$RUN_USER'"

(cd "$APP_DIR" && as_user npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1) \
  || (cd "$APP_DIR" && as_user npm install --omit=dev --no-audit --no-fund >/dev/null) \
  || die "The app's packages could not be installed (npm)."
ok "App packages installed"

# ---------------------------------------------------------------- 4. services
step "Creating the services"
# Run again without --domain: keep the name the monitor is already shared under.
if [ -z "$DOMAIN" ] && [ -f /etc/systemd/system/monitor.service ]; then
  DOMAIN="$(sed -n 's/^Environment=MONITOR_PUBLIC_HOST=//p' /etc/systemd/system/monitor.service | head -1)"
  KEPT_DOMAIN="$DOMAIN"
fi
unit() { # unit <name> <text>
  printf '%s\n' "$2" > "/etc/systemd/system/$1.service"
}
unit monitor-screen "[Unit]
Description=Aviator Live Monitor: virtual screen for the game window

[Service]
User=$RUN_USER
ExecStart=$(command -v Xvfb) $DISPLAY_NO -screen 0 1440x900x24 -nolisten tcp
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target"

unit monitor-vnc "[Unit]
Description=Aviator Live Monitor: VNC view of the game window (this server only)
After=monitor-screen.service
Requires=monitor-screen.service

[Service]
User=$RUN_USER
ExecStart=$(command -v x11vnc) -display $DISPLAY_NO -localhost -forever -shared -nopw -quiet -rfbport $VNC_PORT
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target"

unit monitor-novnc "[Unit]
Description=Aviator Live Monitor: browser view of the game window (this server only)
After=monitor-vnc.service
Requires=monitor-vnc.service

[Service]
User=$RUN_USER
ExecStart=$(command -v websockify) --web=/usr/share/novnc 127.0.0.1:$NOVNC_PORT 127.0.0.1:$VNC_PORT
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target"

unit monitor "[Unit]
Description=Aviator Live Monitor
After=monitor-screen.service network-online.target
Wants=network-online.target
Requires=monitor-screen.service

[Service]
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=DISPLAY=$DISPLAY_NO
Environment=MONITOR_NO_OPEN=1
Environment=PORT=$PORT
Environment=MONITOR_PUBLIC_HOST=$DOMAIN
Environment=MONITOR_GAME_WINDOW_PORT=$NOVNC_PORT
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target"

# Copies started by hand earlier would hold the screen and the ports.
systemctl daemon-reload
systemctl stop monitor monitor-novnc monitor-vnc monitor-screen 2>/dev/null || true
pkill -f "Xvfb $DISPLAY_NO( |\$)" 2>/dev/null || true
pkill -f "x11vnc .*-display $DISPLAY_NO( |\$)" 2>/dev/null || true
rm -f "/tmp/.X${DISPLAY_NO#:}-lock"
for p in $PORT $VNC_PORT $NOVNC_PORT; do
  if ss -ltnp 2>/dev/null | grep -q ":$p "; then
    ss -ltnp | grep ":$p " || true
    die "Port $p is already used by the program shown above. Stop it (a copy of the monitor started by hand, perhaps) and run this again."
  fi
done
systemctl enable -q monitor-screen monitor-vnc monitor-novnc monitor
systemctl restart monitor-screen
sleep 1
systemctl restart monitor-vnc monitor-novnc monitor
sleep 3
for s in monitor-screen monitor-vnc monitor-novnc monitor; do
  if systemctl is-active -q "$s"; then ok "$s is running"
  else journalctl -u "$s" -n 15 --no-pager || true; die "$s did not start (its last lines are above)."; fi
done
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/login" 2>/dev/null || curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/me" \
  || die "The monitor is running but does not answer on port $PORT."
ok "The monitor answers on port $PORT"

# ---------------------------------------------------------------- 5. accounts
step "Sign-in accounts"
accounts() { (cd "$APP_DIR" && as_user "$NODE_BIN" users.js list) | grep -cE $'\t(admin|viewer)$' || true; }
add_account() { # add_account <role> <question>
  local name
  read -r -p "    $2" name
  [ -n "$name" ] || return 1
  until (cd "$APP_DIR" && as_user "$NODE_BIN" users.js add "$name" "$1"); do
    read -r -p "    Try again? Name (empty to skip): " name
    [ -n "$name" ] || return 1
  done
}
if [ "$(accounts)" -gt 0 ]; then
  ok "Accounts already exist:"
  (cd "$APP_DIR" && as_user "$NODE_BIN" users.js list) | sed 's/^/          /'
elif [ -t 0 ]; then
  echo "    The admin account has full control. You type its password here; it is stored only as a hash."
  add_account admin "Admin name (for example your first name): " || warn "No admin account created."
  echo "    A view-only account can watch everything and change nothing (for a client)."
  add_account viewer "View-only name (empty to skip): " || true
else
  warn "Not run from a terminal, so no accounts were created. Add them with:  cd $APP_DIR && sudo -u $RUN_USER node users.js add <name> admin"
fi
if [ "$(accounts)" -eq 0 ]; then
  warn "No accounts: the monitor has no sign-in and works through the SSH tunnel only."
  [ -z "$DOMAIN" ] || die "A domain was asked for, but the monitor is never published without an account. Create one and run this again."
fi

# ---------------------------------------------------------------- 6. domain (optional)
if [ -n "$DOMAIN" ]; then
  step "Publishing at https://$DOMAIN"
  apt-get install -y -qq nginx certbot python3-certbot-nginx >/dev/null
  site="/etc/nginx/sites-available/aviator-monitor"
  cat > "$site" <<NGINX
# Aviator Live Monitor (written by setup.sh). Everything goes through the monitor, which asks
# for a sign-in; the game window is passed on by the monitor to admins only.
server {
  listen 80;
  listen [::]:80;
  server_name $DOMAIN;

  location / {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Connection "";
    proxy_buffering off;          # Live rounds and the game picture are streams.
    proxy_read_timeout 1h;
  }
  # The game window's live connection (a WebSocket), for a signed-in admin.
  location = /vnc/websockify {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_buffering off;
    proxy_read_timeout 1h;
  }
}
NGINX
  ln -sf "$site" /etc/nginx/sites-enabled/aviator-monitor
  nginx -t 2>/dev/null || { nginx -t || true; rm -f /etc/nginx/sites-enabled/aviator-monitor; die "nginx rejected the new site, so it was switched off again. Your other sites were not changed."; }
  systemctl reload nginx
  ok "nginx passes $DOMAIN to the monitor"
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos ${EMAIL:+-m "$EMAIL"} --redirect --keep-until-expiring >/dev/null 2>&1; then
    ok "HTTPS certificate installed (renews by itself)"
  else
    warn "The certificate could not be issued. Check that $DOMAIN points to this server's address and that ports 80 and 443 are open, then run:  sudo certbot --nginx -d $DOMAIN -m $EMAIL --agree-tos --redirect"
  fi
fi

# ---------------------------------------------------------------- done
ip="$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
step "Done"
cat <<DONE
    Everything runs by itself now and starts again after a reboot.

    From your own computer, open a tunnel (and keep that terminal open):

      ssh -L $PORT:127.0.0.1:$PORT -L $NOVNC_PORT:127.0.0.1:$NOVNC_PORT <your-user>@$ip

    Then in your browser:
      Monitor page        http://localhost:$PORT
      Game window         the "Open game window" link on the monitor page (admins only);
                          log in to the game there
DONE
[ -z "$DOMAIN" ] || echo "      Shared address      https://$DOMAIN   (sign-in required)"
cat <<DONE

    Useful later:
      Accounts            cd $APP_DIR && sudo -u $RUN_USER node users.js add|remove|list
      Restart             sudo systemctl restart monitor
      What went wrong     sudo journalctl -u monitor -n 50 --no-pager
      Update the code     cd $APP_DIR && sudo -u $RUN_USER git pull && sudo bash setup.sh
DONE
