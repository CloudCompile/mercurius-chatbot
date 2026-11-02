# privacy@ deletion runbook

What to do when an email to **privacy@trymercurius.com** asks for a
student's data to be deleted (AUD-55 and AUD-53, October 2026 audit).

The promise on `marketing/privacy.html`: we delete the data within
**7 days** of the email. The clock starts when the email arrives, not when
you read it.

## The rules

1. **Erase by full ID or by prefix only.** A full session ID, or the first
   8 or more characters of one. Every version before 2.3 (2.0.0 on the App
   Store, and the 2.1.0 and 2.2.0 TestFlight builds) shows only the first 8
   characters (`SettingsView`, `sessionId.prefix(8)` + "…", from 5018f50
   until f655c85); 2.3 shows the whole ID with a Copy button.
2. **Erase only on exactly one match.** If a prefix matches 0 or 2+
   sessions, erase nothing and write back.
3. **Never find a student any other way.** There are no names on file. Do
   not search message text, report text or dates to guess whose data it
   is.
4. **Erase through the server's own route.** `DELETE /api/session/:id`
   calls `db.deleteSession`, which removes every session-keyed table in one
   transaction (messages, images, reports, usage, lesson_events,
   curriculum_progress, the gamification tables if present, then the
   sessions row). Never hand-write `DELETE` SQL: it would miss tables.
5. **Log the date.** One row per request in a private log *outside this
   repo* (the repo is public). Never put the ID or the sender's email
   address in the log; the email thread is the record of who asked.

## Setup (once per shell)

```bash
export BASE=https://mercurius-chatbot-production.up.railway.app
```

The erase route needs no admin password: the session ID itself is the
proof of ownership (see the comment above the route in `server.js`). `jq`
is optional (`brew install jq`).

**Is 2.3 on the App Store?** Some replies below offer "install the current
version from trymercurius.com/get". `/get` points at the App Store listing
(since 2026-10-24), and only 2.3 and later show the whole ID and have
"Delete my data & start over". Offer it only when this prints 2.3 or later:

```bash
curl -s 'https://itunes.apple.com/lookup?id=6773192313&country=us' | grep -o '"version":"[^"]*"'
```

It printed `"version":"2.0.0"` on 2026-10-24, so don't offer `/get` yet.

## A. The email has the full ID (16+ characters)

App IDs are 32 characters (letters, digits, `-` and `_`); web-widget IDs
start with `merc_` and are longer. Copy it from the email; don't retype it.
Mail apps sometimes turn `-` into `–`: an ID only ever contains `A–Z`,
`a–z`, `0–9`, `-` and `_`.

```bash
ID='<paste the full ID>'
curl -s -X DELETE "$BASE/api/session/$ID" | jq .
```

Read the answer:

- `{"ok":true,"deleted":{"messages":…,"sessions":1}}`: erased. Copy the
  `deleted` counts into the log.
- `"sessions":0` and every count 0: nothing was stored under that ID
  (already erased, never used, or a typo). The route answers 200 either
  way. Check the ID against the email once; if it matches, reply that
  nothing is stored under it.
- `{"error":"invalid_request"}` (400): the ID has a character outside the
  set above or is under 16 characters. Treat it as a prefix (section B) or
  ask for the ID again.
- 429 or 5xx: try again in a minute. A 500 means nothing was erased (the
  transaction rolled back).

## B. The email has a prefix (8+ characters, from a version before 2.3)

Strip any trailing "…". Run this **read-only** query in the Railway
Postgres console (dashboard → the Postgres service → Data, or
`railway connect`, which needs `psql` installed). Put the prefix in both
places:

```sql
SELECT session_id, count(*) AS rows_found
FROM (
  SELECT session_id FROM sessions
  UNION ALL SELECT session_id FROM messages
  UNION ALL SELECT session_id FROM images
  UNION ALL SELECT session_id FROM reports
  UNION ALL SELECT session_id FROM usage
  UNION ALL SELECT session_id FROM lesson_events
  UNION ALL SELECT session_id FROM curriculum_progress
) AS t
WHERE substr(session_id, 1, length('PREFIX')) = 'PREFIX'
GROUP BY session_id;
```

Use exactly this comparison. `LIKE 'PREFIX%'` is wrong here, because IDs
contain `_`, which `LIKE` treats as "any character".

- **Exactly one row:** copy that `session_id` from the result (don't
  retype it) and erase it with the command in section A. Log it.
- **Zero rows:** erase nothing. Reply asking for a screenshot of
  Settings → Session ID (lookalikes such as `l`/`I`/`1` and `O`/`0` are
  the usual cause). Only if the version check above passes, also offer
  installing the current version from `trymercurius.com/get`, which shows
  the whole ID and has "Delete my data & start over". If the data is older
  than the retention windows, there may be nothing left to find; say so.
- **Two or more rows:** erase nothing. Versions before 2.3 can't show more
  than 8 characters. If the version check passes, the way through is
  installing the current version from `trymercurius.com/get`; installing
  it over an older version keeps the same ID (it lives in the Keychain).
  If it doesn't pass, say plainly that we can't tell which session is
  theirs, so nothing was erased; that the data is still deleted on the
  schedule (messages after 90 days, the whole session after 365 days with
  no activity); and that Settings → Start Over gives the phone a new ID so
  nothing more is added under the old one. Web-widget IDs all start with
  `merc_`, so 8 characters of one is never enough.

Tested on 2026-10-18 against a local mock server on SQLite (the query
uses only `substr`/`length`/`UNION ALL`, which Postgres also has): a
shared 8-character prefix returned two rows, a unique one returned one
row, and a one-letter case change returned none. The `DELETE` returned
the per-table counts, then all zeros on a repeat, and 400 for an
8-character ID.

## C. No ID at all (for example, a parent of a child on the under-13 stop screen)

The stop screen hides Settings, so a blocked child can't reach the delete
button or read the ID. Without an ID we can't find the data (rule 3).
Reply with what the privacy page says: whatever is stored is still erased
automatically (messages after 90 days, photos after 24 hours, the whole
session after 365 days with no activity). If the parent finds the ID, or
the first 8 characters from a version before 2.3, run A or B.

Whether an under-13 answer should erase that phone's server data
automatically is a founder decision parked in PR #34 (AUD-53).

## What the erase does not reach

- **Anthropic's copy.** What our server sent Anthropic follows Anthropic's
  own schedule (its published policy for API customers: deleted within 30
  days, longer if flagged by its safety systems or required by law). The
  privacy page says so.
- **Discord notices.** Report notices and alerts stay in the channel. They
  hold no message text, but a report notice carries the first 8 characters
  of the session ID.
- **The phone.** The student's own copy of the chat stays on the phone,
  and the phone keeps the same ID. Anything it sends later is stored again
  under that ID; the server does not block an erased ID. Tell them how to
  get a new ID: before 2.3, Settings → Start Over (it gives a new ID but
  erases nothing on the server); in 2.3 and later, Settings → "Delete my
  data & start over".
- **A network's sign-up and report counts.** Each new session and each
  stored report also leaves a $0 `usage` row (kind `session` or `report`)
  that holds only the network's scrambled address and the day: no session
  ID, no text, and no time of day (the row is dated midnight in
  `STREAK_TZ`). It is what keeps a school's daily
  `IP_DAILY_NEW_SESSIONS` and `IP_DAILY_REPORTS` limits across a deploy,
  so the erase leaves it (it is not tied to the session). The retention
  sweep deletes it after 2 days (`NETWORK_COUNT_RETENTION_DAYS`). Until
  then its row id, which goes up with every row written, still places it
  between the exact times of the rows around it: someone reading the
  database could tell roughly when the session started, or match the row
  to a report's time in Discord.
- **Database backups.** FOUNDER-TODO: check whether the Railway Postgres
  service keeps backups, and for how long. If it does, erased rows live on
  in them until they rotate, and the privacy page should say so.

## Reply templates

Erased:

> We've deleted everything stored on our server under that session ID:
> your messages, photos, reports, usage records, lesson events and lesson
> checklist. Your phone still has the same ID, so anything you send from
> now on is saved again under it. For a fresh ID, use Settings → Start
> Over (versions before 2.3) or "Delete my data & start over" (app 2.3
> and later).
> What our server sent Anthropic to write replies follows Anthropic's own
> deletion schedule, as the privacy page explains.

Need more:

> Those characters don't point to exactly one session, so we haven't
> deleted anything yet. Could you send a screenshot of Settings → Session
> ID?

Add this sentence only if the version check passes:

> Or install the current version from trymercurius.com/get: it shows the
> whole ID and has a "Delete my data & start over" button that does this
> right away.

## The log (private, outside this repo)

One row per email:

| Received | Due (received + 7 days) | Done | How identified (full / prefix / none) | Result (`deleted` counts, or "no match", "2+ matches") |
|---|---|---|---|---|
