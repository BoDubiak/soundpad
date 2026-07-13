# Deploy Soundpad on an OVH VPS

The production stack runs Caddy, the React frontend, FastAPI, PostgreSQL, `ffmpeg`, and `yt-dlp` in Docker.

## 1. Prepare the VPS

Create the VPS with Ubuntu 24.04 LTS, then connect from your computer:

```bash
ssh ubuntu@YOUR_SERVER_IP
```

Update Ubuntu and install Docker:

```bash
sudo apt update
sudo apt upgrade -y
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
exit
```

Reconnect over SSH so the Docker group takes effect.

## 2. Point the domain to the server

At your DNS provider, create an `A` record pointing the chosen hostname to the VPS IPv4 address. For example:

```text
soundpad.example.com -> YOUR_SERVER_IP
```

Wait until this command returns the VPS address:

```bash
getent hosts soundpad.example.com
```

If you do not have a domain yet, skip this step. In `.env.production`, use
`SITE_ADDRESS=http://YOUR_SERVER_IP`, `PUBLIC_BASE_URL=http://YOUR_SERVER_IP`, and
`SECURE_COOKIES=false`. Switch to a domain and HTTPS before inviting users.

## 3. Copy the project

The easiest repeatable option is to push the project to a private Git repository and clone it on the VPS:

```bash
sudo mkdir -p /opt/soundpad
sudo chown "$USER":"$USER" /opt/soundpad
git clone YOUR_REPOSITORY_URL /opt/soundpad
cd /opt/soundpad
```

Without a Git repository, create an archive in PowerShell on your computer:

```powershell
cd D:\Soundpad
tar --exclude=.git --exclude=frontend/node_modules --exclude=frontend/dist --exclude=backend/.venv --exclude=backend/uploads --exclude=.env --exclude=.env.production --exclude=backend/.env -czf soundpad-deploy.tar.gz .
scp .\soundpad-deploy.tar.gz ubuntu@YOUR_SERVER_IP:/tmp/
```

Then unpack it on the VPS:

```bash
sudo mkdir -p /opt/soundpad
sudo tar -xzf /tmp/soundpad-deploy.tar.gz -C /opt/soundpad
sudo chown -R "$USER":"$USER" /opt/soundpad
cd /opt/soundpad
```

## 4. Configure production secrets

```bash
cp .env.production.example .env.production
nano .env.production
```

Set `SITE_ADDRESS` to the hostname without a scheme and set `PUBLIC_BASE_URL` to its HTTPS URL. Generate two different secrets:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

Use one value for `POSTGRES_PASSWORD` and the other for `JWT_SECRET_KEY`.

## 5. Allow only required ports

Allow SSH before enabling the firewall:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw enable
```

Do not expose PostgreSQL port 5432.

## 6. Start Soundpad

```bash
cd /opt/soundpad
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
docker compose --env-file .env.production -f docker-compose.prod.yml ps
```

Caddy obtains and renews the HTTPS certificate automatically. View logs if a service is not healthy:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml logs --tail=200
```

## Updating

```bash
cd /opt/soundpad
git pull
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

The PostgreSQL and upload volumes survive rebuilds. They are not a backup; copy them to storage outside this VPS.
