# Running NECAP (local-rag) in Docker

This document captures the Docker setup for this project: the files involved, why they're
structured the way they are, and — most importantly — the CLI commands you need any time you
change the host code and want the container to pick up those changes.

## Files involved

- `Dockerfile` — builds the image (`node:26-slim`, installs dependencies, copies in the app,
  runs `node index.js`).
- `.dockerignore` — keeps `node_modules`, `.env`, `.env.*`, and `logs` out of the built image.
- `docker-compose.yml` — the service definition: image name, port mapping, environment
  variables, and the three named volumes.
- `.env.docker` — container-only login credentials (`AUTH_USER`/`AUTH_PASSWORD` or
  `AUTH_USERS`), kept separate from the host's own `.env` so the container never silently
  picks up the host's `PORT=8080` or local `OLLAMA_BASE_URL` override. Covered by
  `.dockerignore`'s `.env.*` entry and should be added to `.gitignore` too if this project is
  ever put under version control.

## The one-time setup (background, for reference)

These are already done and don't need repeating unless you're rebuilding from scratch:

- `idealProposals.json` and `bestPractices.json` were moved from the project root into a
  `benchmarkData/` folder, so every piece of persisted data (`workspaces/`, `logs/`,
  `benchmarkData/`) is a folder — named volumes are directory-only, so this made all three
  uniform.
- Three named volumes were created and pinned to exact names in `docker-compose.yml`:

  ```yaml
  volumes:
    necap-workspaces:
      name: necap-workspaces
      external: true
    necap-logs:
      name: necap-logs
      external: true
    necap-benchmarkdata:
      name: necap-benchmarkdata
      external: true
  ```

  `external: true` tells Compose these volumes already exist and must not be silently
  recreated under a different (project-prefixed) name — this is what fixed an earlier mistake
  where Compose created `codebase_necap-workspaces` etc. instead of reusing the real ones.
- The container uses `init: true` (Compose's equivalent of `docker run --init`) so Ctrl+C and
  Docker Desktop's Stop button actually work. Without it, plain `node` as PID 1 never responds
  to `SIGINT`/`SIGTERM`, and the container has to be force-killed every time.
- `OLLAMA_BASE_URL` is set to `http://host.docker.internal:11434` so the container can reach
  the native Ollama install running on the host (`localhost` inside a container means the
  container itself, not the host machine).

## Day-to-day: rebuilding after a code change

**This is the key thing to remember:** Docker Desktop's Play button only *starts* the image
exactly as it was last built. It does **not** notice that `index.js` or anything under `src/`
or `public/` changed. After editing host code, you need to rebuild the image before Play (or
`docker compose up`) will reflect the change.

From the project root (same folder as `Dockerfile` and `docker-compose.yml`):

```
docker compose up --build
```

This rebuilds the image (reusing Docker's layer cache, so it's fast unless `package*.json`
changed) and then starts the container with the new code. Run it in the foreground to watch
the logs, or add `-d` to run it detached:

```
docker compose up --build -d
```

After this, Docker Desktop's Play/Stop buttons work normally against the freshly-built image
— you only need the CLI command again the *next* time you change code.

If you only want to rebuild without starting it (e.g. to catch build errors before running):

```
docker compose build
```

## Other useful commands

Check what's running:

```
docker ps
docker compose ps
```

Follow logs (if running detached, or from Docker Desktop's Containers view):

```
docker compose logs -f necap
```

Stop the container cleanly (safe — this does **not** delete the named volumes, since they're
marked `external: true`):

```
docker compose down
```

If a container is ever genuinely stuck and won't respond to a stop request (shouldn't happen
now that `init: true` is set, but just in case):

```
docker ps
docker kill <container id or name>
```

List and inspect volumes (useful for confirming data actually persisted):

```
docker volume ls
docker volume inspect necap-workspaces
```

## Cleaning up orphaned volumes (one-time, if not already done)

Early on, before the `external: true` fix, Compose created duplicate volumes under a
project-name prefix (`codebase_necap-workspaces`, `codebase_necap-logs`,
`codebase_necap-benchmarkdata`). These are harmless but unused. Safe to remove once you've
confirmed the real `necap-*` volumes have your actual data:

```
docker volume rm codebase_necap-benchmarkdata codebase_necap-logs codebase_necap-workspaces
```

## Credentials (`.env.docker`)

Plain `KEY=VALUE` lines, `#` for comments, same format as a normal `.env` file:

```
# Container login credentials
AUTH_USER=someusername
AUTH_PASSWORD=somepassword

# Or, for multiple named logins instead:
# AUTH_USERS=alice:secret1,bob:secret2
```

Referenced in `docker-compose.yml` via:

```yaml
    env_file: .env.docker
```

Remember: a password-protected uploaded file is unrelated to this — this is purely the HTTP
Basic Auth login for the app itself. Keep real/test credentials separate and don't leave test
accounts in this file once the container is actually in use.

## Public access via Tailscale Funnel

The container is exposed to the public internet (not just this laptop) via Tailscale Funnel,
which also provides a free, real HTTPS certificate under this device's own `*.ts.net`
subdomain — no domain purchase or reverse proxy needed.

Turn it on (runs in the background, resumes automatically after a reboot):

```
tailscale funnel --bg 3500
```

Check status / get the actual public URL:

```
tailscale funnel status
```

Turn it off (repeat the exact command used to turn it on, with `off` appended):

```
tailscale funnel --bg 3500 off
```

Or, to wipe the Funnel configuration entirely:

```
tailscale funnel reset
```

**Security note:** Funnel makes the app reachable by anyone on the internet who has (or
guesses, or stumbles on via Certificate Transparency logs) the URL. HTTP Basic Auth is the
only real gate at that point — use strong, non-default credentials in `.env.docker`, and
prefer `AUTH_USERS` (one login per person) over a single shared `AUTH_USER`/`AUTH_PASSWORD` so
individual access can be revoked without changing everyone's password.

## Quick reference: full workflow after changing code

```
# 1. Rebuild the image and start the container with the new code
docker compose up --build -d

# 2. Confirm it's running
docker compose ps

# 3. Watch logs if something looks wrong
docker compose logs -f necap

# 4. From here on, Docker Desktop's Play/Stop buttons work normally
#    — until the next code change, when you repeat step 1.
```
