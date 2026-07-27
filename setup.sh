#!/bin/bash
set -e

echo ""
echo "══════════════════════════════════════════"
echo "  NAHDRAN — Server Setup"
echo "══════════════════════════════════════════"
echo ""

# ─── System packages ───────────────────────
echo "[1/7] Installing system packages..."
apt update -qq
apt install -y -qq nginx certbot python3-certbot-nginx ufw > /dev/null 2>&1

# ─── Node.js 22 ────────────────────────────
if ! command -v node &> /dev/null || [[ $(node -v) != v22* ]]; then
  echo "[2/7] Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
  apt install -y -qq nodejs > /dev/null 2>&1
else
  echo "[2/7] Node.js $(node -v) already installed."
fi

# ─── Firewall ──────────────────────────────
echo "[3/7] Configuring firewall..."
ufw allow OpenSSH > /dev/null 2>&1
ufw allow 80 > /dev/null 2>&1
ufw allow 443 > /dev/null 2>&1
ufw --force enable > /dev/null 2>&1

# ─── App dependencies ─────────────────────
echo "[4/7] Installing app dependencies..."
cd /opt/nahdran
npm ci --production > /dev/null 2>&1

# ─── Environment file ─────────────────────
echo "[5/7] Generating secrets..."
if [ ! -f .env ]; then
  JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
  cat > .env << EOF
NODE_ENV=production
PORT=3000
JWT_SECRET=$JWT_SECRET
EOF
  echo "  .env created with new JWT_SECRET"
else
  echo "  .env already exists, skipping"
fi

# ─── Systemd service ──────────────────────
echo "[6/7] Creating systemd service..."
cat > /etc/systemd/system/nahdran.service << 'EOF'
[Unit]
Description=NAHDRAN API
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/nahdran
EnvironmentFile=/opt/nahdran/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable nahdran > /dev/null 2>&1
systemctl restart nahdran

# Wait and verify
sleep 2
if systemctl is-active --quiet nahdran; then
  echo "  App is running!"
else
  echo "  ERROR: App failed to start. Run: journalctl -u nahdran -n 20"
  exit 1
fi

# ─── nginx ─────────────────────────────────
echo "[7/7] Configuring nginx..."
read -p "Enter your domain (e.g. app.nahdran.de): " DOMAIN

cat > /etc/nginx/sites-available/nahdran << NGINXEOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_cache_bypass \$http_upgrade;
    }
}
NGINXEOF

ln -sf /etc/nginx/sites-available/nahdran /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

echo ""
echo "══════════════════════════════════════════"
echo "  DONE! App running at http://$DOMAIN"
echo "══════════════════════════════════════════"
echo ""
echo "  Next steps:"
echo "  1. Make sure DNS points $DOMAIN → $(curl -s ifconfig.me)"
echo "  2. Then run:  certbot --nginx -d $DOMAIN"
echo ""
echo "  Test now:  curl http://localhost:3000/api/categories"
echo ""
