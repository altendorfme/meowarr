# Meowarr 😺

[![en](https://img.shields.io/badge/lang-en-red.svg)](README.md)
[![pt-br](https://img.shields.io/badge/lang-pt--br-green.svg)](README.pt-BR.md)

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white)](https://expressjs.com)
[![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white)](https://github.com/WiseLibs/better-sqlite3)
[![Bootstrap](https://img.shields.io/badge/Bootstrap-5-7952B3?logo=bootstrap&logoColor=white)](https://getbootstrap.com)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com)

IPTV playlist (`.m3u8`) and EPG manager.
Register sources (Git or URL), apply filters and republish filtered playlists + EPG over a public URL.
Compatible with **HDHomeRun (HDHR)** clients.

## 📸 Screenshots

![Home](docs/screenshots/1.jpg)
![Images](docs/screenshots/2.jpg)
![Lists](docs/screenshots/3.jpg)

## 🚀 Deploy

### Docker

```yaml
services:
  meowarr:
    image: ghcr.io/altendorfme/meowarr:latest
    container_name: meowarr
    ports:
      - "9797:9797"
    environment:
      - TZ=America/Sao_Paulo
      - ADMIN_PASSWORD=change-this-password
      - SESSION_SECRET=change-this-long-random-secret
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

```bash
docker compose up -d
```

Open `http://localhost:9797` and log in with the password set in `ADMIN_PASSWORD`.

### Node.js ≥ 20

```bash
git clone https://github.com/<your-user>/meowarr.git
cd meowarr
cp .env.example .env
# edit .env and set ADMIN_PASSWORD and SESSION_SECRET
npm install
npm start
```

For development with auto-reload:

```bash
npm run dev
```

## 🌐 Public URLs

| Resource | URL |
|---|---|
| M3U8 playlist | `http://host:9797/lists/<slug>/m3u8` |
| EPG XML | `http://host:9797/epg/<slug>.xml` |
| HDHR | `http://host:9797/lists/<slug>/hdhr` |

Each list can optionally require **HTTP Basic auth** configured in the editor:
`http://user:password@host:9797/lists/<slug>/m3u8`

## ⚙️ Environment variables

| Var | Default | Description |
|---|---|---|
| `PORT` | `9797` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `ADMIN_PASSWORD` | - | **Required.** Single admin password |
| `SESSION_SECRET` | - | **Required.** Session cookie secret |
| `PUBLIC_BASE_URL` | - | Public URL shown in the UI |
| `DATA_DIR` | `./data` (host) / `/app/data` (Docker) | SQLite, cloned repos, EPG cache |
| `CRON_DAILY` | `0 4 * * *` | Daily routine cron |
| `TZ` | - | Timezone (e.g.: `UTC`) |
| `HDHR_TUNER_COUNT` | `4` | Tuners reported by HDHR |

## 🤝 Contributing

Issues and pull requests are welcome.
