# GitHub Actions CI/CD

The workflow in `.github/workflows/ci-cd.yml` verifies pull requests and deploys every successful push to `main`
or `master` to the OVH VPS.

## 1. Create a private GitHub repository

Create an empty private repository on GitHub. Do not initialize it with a README. Then, from PowerShell in this
project, commit the current files and add the repository as `origin`:

```powershell
cd D:\Soundpad
git add .
git commit -m "Add OVH deployment and CI/CD"
git remote add origin YOUR_GITHUB_REPOSITORY_URL
git push -u origin master
```

If GitHub created `main` instead, rename before pushing:

```powershell
git branch -M main
git push -u origin main
```

## 2. Prepare the VPS once

Connect to the VPS and install Docker and `rsync`:

```bash
ssh ubuntu@57.129.118.110
sudo apt update
sudo apt upgrade -y
sudo apt install -y rsync
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
sudo mkdir -p /opt/soundpad
sudo chown -R "$USER":"$USER" /opt/soundpad
exit
```

Reconnect so the Docker group membership takes effect.

## 3. Create a dedicated deployment key

Generate a key on your Windows computer. Do not add a passphrase because GitHub Actions must use it unattended:

```powershell
ssh-keygen -t ed25519 -C "github-actions-soundpad" -f "$env:USERPROFILE\.ssh\soundpad_deploy"
Get-Content "$env:USERPROFILE\.ssh\soundpad_deploy.pub" | ssh ubuntu@57.129.118.110 "umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys"
```

Test the key:

```powershell
ssh -i "$env:USERPROFILE\.ssh\soundpad_deploy" ubuntu@57.129.118.110
```

## 4. Create the production environment file

On the VPS:

```bash
cd /opt/soundpad
nano .env.production
```

For the initial deployment without a domain, use:

```dotenv
SITE_ADDRESS=http://57.129.118.110
PUBLIC_BASE_URL=http://57.129.118.110
SECURE_COOKIES=false
POSTGRES_PASSWORD=GENERATE_A_RANDOM_VALUE
JWT_SECRET_KEY=GENERATE_A_DIFFERENT_RANDOM_VALUE
YOUTUBE_TEMP_TTL_HOURS=24
```

Generate each secret with `openssl rand -hex 32`. The workflow excludes this file from synchronization and Git.

## 5. Add GitHub Actions secrets

Open the GitHub repository and go to **Settings → Secrets and variables → Actions → New repository secret**.
Add:

| Secret | Value |
| --- | --- |
| `DEPLOY_HOST` | `57.129.118.110` |
| `DEPLOY_USER` | `ubuntu` |
| `DEPLOY_SSH_KEY` | The complete contents of `~/.ssh/soundpad_deploy`, including the BEGIN/END lines |
| `DEPLOY_KNOWN_HOSTS` | The output of `ssh-keyscan -H 57.129.118.110` |

Get the private key and host-key values in PowerShell:

```powershell
Get-Content -Raw "$env:USERPROFILE\.ssh\soundpad_deploy"
ssh-keyscan -H 57.129.118.110
```

Compare the key fingerprint with the one accepted during your first manual SSH connection before saving it.

## 6. Deploy

Push a commit to `main` or `master`. Follow the run under the repository's **Actions** tab. The workflow will:

1. install and check backend dependencies;
2. lint and build the frontend;
3. validate Docker Compose;
4. securely synchronize the source to `/opt/soundpad`;
5. rebuild and restart the production containers;
6. wait for PostgreSQL and FastAPI health checks.

The first deployment downloads Docker images and takes longer. Later deployments reuse cached image layers.
