# Backup and restore

Two deployments, two answers. Both are tested; neither needs a support engineer.

---

## The desktop app (and any self-hosted copy)

Everything Soundwave remembers lives in one folder:

| Platform | Where |
| --- | --- |
| Windows | `%APPDATA%\Soundwave AI\data` |
| macOS | `~/Library/Application Support/Soundwave AI/data` |
| Linux | `~/.config/Soundwave AI/data` |

(It is `DATA_DIR` if you set one. The folder is also printed by
`GET /api/ready` and by **Settings → Help → Copy diagnostics**.)

Inside it: `store.json` (accounts, projects, export jobs, usage), `brand.json`,
`memory.json`, `agent-conversation.json`, `posts.json`, the channels being
watched, `voice-clips/` and `projects/`.

### Automatically, every day

Every clean write of `store.json` keeps a dated copy beside it —
`store.backup-2026-10-06.json` — and the **seven most recent days are kept**.
This is not a replacement for an export (it is local, and it covers the store
only), but it is what turns "Soundwave came up empty today" into a two-minute
fix: the loader walks those backups newest-first and recovers from the first one
that parses. If none does, it says so on `/api/ready` rather than pretending
you never had data.

### On purpose: export and restore

**Settings → Help → Your Data**, or over HTTP:

```bash
# Take a copy (safe to keep in Dropbox — secrets are stripped on the way out)
curl -H "Origin: http://127.0.0.1:47800" \
     -o soundwave-backup.zip \
     http://127.0.0.1:47800/api/v1/backup/export

# Put one back (the app must be restarted afterwards)
curl -X POST -H "Origin: http://127.0.0.1:47800" \
     -H "Content-Type: application/zip" \
     --data-binary @soundwave-backup.zip \
     http://127.0.0.1:47800/api/v1/backup/restore
```

Both routes are desktop-only: from a hosted deployment they answer 404, because
there the data is in Postgres and `pg_dump` is the right tool (below).

**What the export contains.** Every file under the data folder, minus:

* anything that looks like a credential — API keys, OAuth tokens, refresh
  tokens, pairing keys, passwords, session ids. The key stays (so the shape is
  still readable) with `"[removed]"` as its value, and the manifest lists the
  dotted path of each one, e.g. `brain.geminiApiKey`.
* half-written `.tmp` files and quarantine copies (`.corrupt-…`), which are not
  data.

The archive is a plain zip, so you can open it without Soundwave. The first
entry in it is `soundwave-backup.json` — a manifest with the version, the file
list and what was redacted.

**What a restore checks before writing anything.** That it is a zip, that it has
our manifest, that the archive is not from a newer app version, and that every
entry is a plain relative file name (an entry like `../something` or
`/etc/something` is refused). Only then is your current data moved — **moved,
not deleted** — into `restored-from-<timestamp>/` inside the data folder, and
the archive written over the top. A restore of the wrong file is recoverable.

Restart Soundwave after a restore: the running process holds the previous
contents in memory.

---

## The hosted deployment (Postgres)

There the store is the database, not a folder. Set up a nightly dump:

```bash
# /etc/cron.d/soundwave-backup — keep 30 days
0 3 * * * postgres pg_dump "$DATABASE_URL" --format=custom --no-owner \
            --file=/backups/soundwave-$(date +\%F).dump
15 3 * * * root find /backups -name 'soundwave-*.dump' -mtime +30 -delete
```

Restore with `pg_restore --clean --if-exists --dbname "$DATABASE_URL" <dump>`.

Test it before you need it — restore into a scratch database and point a
staging server at it. A dump nobody has restored is a hope, not a backup.

`/api/ready` is the health check that matters here: it fails (503) when the
store could not be read and there was no usable backup, which is exactly the
state a botched migration leaves behind. Wire it to your monitor.
