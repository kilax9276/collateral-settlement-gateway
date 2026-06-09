# Deployment Guide

This guide describes how to run Collateral Settlement Gateway in local development, testnet, and a server-style environment. The project is designed as a reference implementation, so production deployments require additional security and operational work before handling real value.

## 1. Local development

Install dependencies:

```bash
npm ci
cp .env.example .env
```

Start a local chain:

```bash
npm run chain
```

Deploy contracts:

```bash
npm run deploy:local
```

Start the backend and dashboard:

```bash
npm run dev
```

Open:

```text
http://localhost:3000/health
http://localhost:3000/docs
http://localhost:3000/dashboard
```

Run the full workflow:

```bash
npm run demo:e2e
```

## 2. Docker-based local run

The repository includes `Dockerfile` and `docker-compose.yml` for local containerized execution. Use Docker for repeatable evaluation, not as a final production recipe.

```bash
docker compose up --build
```

Recommended local ports:

```text
8545 - local JSON-RPC
3000 - API and dashboard
```

## 3. Testnet deployment

Configure environment variables:

```dotenv
SEPOLIA_RPC_URL=
ARBITRUM_SEPOLIA_RPC_URL=
DEPLOYER_PRIVATE_KEY=
ETHERSCAN_API_KEY=
```

Deploy:

```bash
npm run deploy:sepolia
# or
npm run deploy:arbitrum-sepolia
```

Verify where supported:

```bash
npm run verify:sepolia
npm run verify:arbitrum-sepolia
```

The deploy script writes network-specific contract metadata for backend usage. Generated local contract files must not be committed.

## 4. Server deployment pattern

A senior-style deployment should separate responsibilities clearly:

1. **Host** — provision a Linux VM with locked-down SSH, firewall rules, and automatic security updates.
2. **Runtime** — install Node.js 22+ using a deterministic method such as NodeSource, asdf, or a pinned container image.
3. **RPC** — use a managed RPC provider or an internally operated node; do not rely on a public unauthenticated endpoint.
4. **Secrets** — load private keys, app secrets, admin tokens, and RPC credentials from a secrets manager or secure environment injection.
5. **Contracts** — deploy contracts through a controlled signer and record addresses in generated contract metadata.
6. **Process management** — run the backend under systemd, Docker, or another supervised runtime.
7. **Reverse proxy** — place Nginx, Caddy, or a cloud load balancer in front of the API with TLS enabled.
8. **Storage** — SQLite is acceptable for reference/local deployments; use Postgres with migrations and backups for serious environments.
9. **Monitoring** — track health checks, indexer lag, settlement failures, reconciliation status, Vault liquidity, RPC errors, and process restarts.
10. **Access control** — disable demo routes, rotate default secrets, restrict admin endpoints, and keep operator keys outside the application repository.

## 5. Example systemd unit

```ini
[Unit]
Description=Collateral Settlement Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/collateral-settlement-gateway
EnvironmentFile=/etc/collateral-settlement-gateway.env
ExecStart=/usr/bin/node dist/backend/src/server.js
Restart=always
RestartSec=5
User=csg
Group=csg
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

Build and start:

```bash
npm ci
npm run build
sudo systemctl daemon-reload
sudo systemctl enable collateral-settlement-gateway
sudo systemctl start collateral-settlement-gateway
```

## 6. Reverse proxy example

```nginx
server {
  listen 443 ssl http2;
  server_name gateway.example.com;

  ssl_certificate /etc/letsencrypt/live/gateway.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/gateway.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location /ws {
    proxy_pass http://127.0.0.1:3000/ws;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
  }
}
```

## 7. Deployment checklist

Before any shared deployment:

- [ ] Replace all default secrets.
- [ ] Disable `ENABLE_DEMO_ROUTES`.
- [ ] Use a dedicated operator key with limited funding.
- [ ] Restrict admin endpoint access.
- [ ] Configure structured logs and log rotation.
- [ ] Configure monitoring and alerting.
- [ ] Configure database backups.
- [ ] Run `npm run format:check`, `npm run lint`, `npm run build`, `npm test`, and `npm run test:e2e`.
- [ ] Confirm contract addresses and chain ID.
- [ ] Run reconciliation after deployment.

## 8. Real-funds warning

Do not use this repository with real funds as-is. A real deployment needs smart-contract audit, backend security review, hardened key management, durable storage, RBAC, monitoring, incident procedures, and legal/compliance review for the intended jurisdiction and product.
