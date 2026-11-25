---
title: Backup and restore
description: One Postgres dump backs up the whole instance.
---

Application data is in the one Postgres database: accounts, drawings, images,
share links, private assistant conversations, tasks, events and operation receipts.
One dump backs up the instance. Also keep a copy of your
`.env`.

The separate [Codex connector](/docs/ai-assistant/) keeps a private local state
directory with its identity, thread references and unconfirmed final reports.
Back that up separately if you run it, along with Codex's native session state
when you want to preserve those threads. Run one copy of a restored connector
state directory. The full conversation and committed drawing operations remain
in the application database.

## Back up

From the directory containing `docker-compose.yaml`:

```bash
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > excaliself-$(date +%F).dump
```

## Restore

Restore with the app stopped. This replaces the current data:

```bash
docker compose stop excaliself
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < excaliself-2026-10-13.dump
docker compose start excaliself
```

Restore into the same or a newer version of the app: it migrates the data on
start. An older version cannot read a newer dump, because there are no down
migrations. Take a dump before each upgrade: restoring it is the safe way
back to the older version.

## On Coolify

Run the same commands against the `db` container from the server's shell, with
`docker exec` and the container name from `docker ps`.
