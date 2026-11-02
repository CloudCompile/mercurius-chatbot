# 2.3.0 review rehearsal (on-device, before you submit)

Run this on a real iPhone with the **exact TestFlight build you intend to
submit**: 2.3.0 (16), main plus fix/ios-hardening (same build number). It
walks the app the way App Review will, and checks the server side of each
promise the listing makes. Budget about 45 minutes. If any step fails, fix
it and start again from step 1 on a new build — do not submit a build you
have only partly rehearsed.

Companion: [`APP_STORE_LISTING.md`](APP_STORE_LISTING.md) (what you are
promising) and `ios/docs/APP_STORE.md` (the shipping gates).

## Before you start

You need:

- The phone, on Wi-Fi, with TestFlight installed and the 2.3.0 build available.
- A Mac on the same Wi-Fi with `curl` and the admin password for production.
- Access to the Railway project (for logs) **or** an HTTPS proxy on the Mac
  (Proxyman, Charles or mitmproxy). Either works for step 7.
- The Discord alerts channel open (the one `DISCORD_WEBHOOK_URL` posts to).

Set these in the Mac shell once; every curl below uses them:

```bash
export BASE=https://mercurius-chatbot-production.up.railway.app
export ADMIN='<the production ADMIN_PASSWORD>'   # never paste it into chat or a commit
```

Sanity check the backend before touching the phone:

```bash
curl -s "$BASE/api/health"
# expect: {"status":"ok", ...}   (a 503 with "draining" means a deploy is in flight — wait)

curl -s -H "x-admin-password: $ADMIN" "$BASE/api/admin/kill-switch"
# expect: {"ok":true,"disabled":false, ...}   — if disabled is true, someone left it on; turn it off (step 11) first
```

A note on "fresh install": the anonymous session id lives in the **Keychain**
and survives deleting the app. For a truly fresh state either use a phone
that has never run Mercurius, or run **Settings → Delete my data & start
over** before deleting the app. Steps 1–3 assume a fresh state.

## The checklist

Tick each line only when you saw the expected result yourself.

### First launch and the age gate

1. **Fresh install → open the app.**
   Expected: "Meet Merc" (the mascot intro), then after Continue the age
   check. No tutor content, no chat input, no network spinner before it.

2. **Enter age 12.**
   Expected: the wheel opens on "Select your age" and Continue stays off
   until you pick. After 12: "Mercurius is for ages 13 and up", with no
   button at all (no "I picked the wrong age") and nothing that leads into
   the app. Force-quit and relaunch: the app opens straight on the stop
   screen. This device remembers the stop for 7 days, keeping only the time
   of the stop, never the age. Deleting the app clears it, which step 3
   relies on. Nothing should have hit the server (you will confirm this in
   step 7). If you see a retry button, or the relaunch starts at "Meet
   Merc", you are on build 15. Stop and install build 16: App Review note 1
   (APP_STORE_LISTING.md §4) describes build 16.

3. **Delete the app, reinstall from TestFlight, enter age 15.**
   Expected: the **disclosure** screen: messages and attached photos go
   through our server to Anthropic's Claude; links to Privacy and Terms; an
   **Agree** button and a **Not now** option.

4. **Tap "Not now".**
   Expected: the app pauses at this screen (or a neutral holding screen) and
   nothing is sent. Force-quit and relaunch: it returns to the disclosure, not
   to the tutor. Tap the Privacy and Terms links: they open in Safari over
   https and both pages load.

5. **Tap Agree.**
   Expected: the **AI limits** screen — the tutor can be wrong, is not a
   person, is not for emergencies — and the **988** Suicide & Crisis Lifeline
   is shown. Continue.

6. **"Your path" → Lesson 1.**
   Expected: Unit 1's lessons are listed, with a Reminders section holding
   two switches, both off: "Weekly nudges (Wed & Sun)" and "Daily streak
   reminder". Leave them off for now. Tap **Start Lesson 1**: the lesson
   streams in beats and at least one **KEY IDEA** or **CHECK** card appears
   and expands when tapped.

7. **Confirm nothing reached the server before Agree.** Pick one:

   *Railway logs:* open the service's logs (dashboard → Deployments → View
   Logs, or `railway logs`) and read the lines for the minutes covering
   steps 1–6. Expected: **no** `/api/…` request from your phone until after
   Agree; the first one should be the Lesson 1 request (`POST /api/chat`) or
   a `GET /api/session/<id>` immediately before it. If you cannot tell your
   phone's requests apart from other students', do the proxy variant instead.

   *Proxy:* install the proxy's CA profile on the phone, trust it under
   Settings → General → About → Certificate Trust Settings, point the phone's
   Wi-Fi proxy at the Mac, then repeat steps 1–6 on a fresh state. Expected:
   the request list for `mercurius-chatbot-production.up.railway.app` is
   empty until Agree. Remove the proxy and the CA profile when you are done.

### Failure copy

8. **Airplane mode mid-lesson.** Turn Airplane Mode on, then send a message
   in the lesson.
   Expected: the reply fails with a plain, non-technical message and a
   **Retry** control; the lesson is not marked complete; nothing crashes. Turn
   Airplane Mode off and tap Retry: the reply streams.

9. **Report a reply with a reason.** Long-press any tutor reply → **Report** →
   pick **wrong** (or any of wrong / harmful / off topic / other) → confirm.
   Expected: a "Reported" confirmation. Then on the Mac:

   ```bash
   curl -s -H "x-admin-password: $ADMIN" "$BASE/api/admin/reports?unresolved=1"
   ```

   Expected: a JSON list whose newest entry has your reason, a timestamp from
   the last minute, and the reported text. (`/api/admin/reports` is new in the
   2.3.0 server — a 404 means the server is not on the 2.3.0 deploy yet.)
   Also expected: a **Discord notification** in the alerts channel within a
   few seconds, containing the reason and a session id prefix only — it must
   **not** contain the reported text.

10. **Kill switch on.**

    ```bash
    curl -s -X POST -H "x-admin-password: $ADMIN" -H "Content-Type: application/json" \
      -d '{"disabled":true}' "$BASE/api/admin/kill-switch"
    # expect: {"ok":true,"disabled":true,"source":"runtime","persisted":true}
    ```

    Send a message in the app. Expected: the **paused** copy (server text:
    "Mercurius is temporarily paused — please try again soon."), no crash, no
    raw error code, and the message is retryable. A Discord message "Kill
    switch ON" also arrives.

11. **Kill switch off.**

    ```bash
    curl -s -X POST -H "x-admin-password: $ADMIN" -H "Content-Type: application/json" \
      -d '{"disabled":false}' "$BASE/api/admin/kill-switch"
    # expect: {"ok":true,"disabled":false, ...}
    ```

    Retry the message. Expected: it streams normally. **Do not leave the
    switch on** — check with the GET from "Before you start".

12. **Daily-limit copy.** Hitting a real per-session daily limit is not
    practical on production. Instead, run the server locally with the mock
    (`ANTHROPIC_MOCK=1` and a tiny quota, e.g. `SESSION_DAILY_LESSON_TURNS=1`
    — see `lib/quotas.js` for the env names) and point a debug build at it, or
    skip this step. Expected text when it does fire: "You've used today's
    lesson turns. Try again after 11:00 PM." (the server's "Lessons come
    back tomorrow." swapped for the local time the allowance comes back; or
    the chat / photo variants), shown plainly with no retry spinner.

### Settings, deletion and consent

13. **Settings shows the session id.** Open Settings.
    Expected: the full 32-character id is visible and **copyable** (tap or
    long-press copies it). Copy it and paste it into the Mac shell:

    ```bash
    export OLD_ID='<paste the id>'
    curl -s "$BASE/api/session/$OLD_ID"
    # expect: {"stats":{"session":{"streak":...,"message_count":N,...}}}  with N > 0
    curl -s "$BASE/api/progress/$OLD_ID"
    # expect: "lessons":[{"id":"u1_l1","status":"completed",...}] once Lesson 1 is finished
    #         (an empty "lessons":[] if you have not finished it yet)
    ```

14. **Delete my data & start over.** Settings → **Delete my data & start
    over** → confirm.
    Expected: the app returns to a clean state and Settings shows a
    **different** session id. Then:

    ```bash
    curl -s "$BASE/api/session/$OLD_ID"
    # expect: {"stats":{"session":null}}   — the old session is gone
    curl -s "$BASE/api/progress/$OLD_ID"
    # expect: "lessons":[] and "units":[]   — the synced checklist went with it
    ```

    (The server's `DELETE /api/session/:id` is idempotent, so the app calling
    it twice is fine; what matters is that the GET above returns `null`.)

15. **Privacy choices → Withdraw consent.** Settings → Privacy choices →
    Withdraw consent → confirm.
    Expected: the app returns to the first-launch flow (age check, then the
    disclosure). Agree again to keep rehearsing.

16. **Help & FAQ and Contact support.** Tap each in Settings.
    Expected: Help & FAQ opens `https://trymercurius.com/support` in Safari;
    Contact support opens a mail draft to `support@trymercurius.com` (or the
    support page if mail is not set up). Nothing opens inside the app as an
    embedded browser.

### Modes, photos and links

17. **Modes.** In chat, switch Socratic → Discussion → Debate with the pills.
    Expected: exactly three pills, no "Direct". Discussion returns a scored
    response to a reflection; Debate argues the other side and cites sources.

18. **Photo.** Tap the photo button left of the message field, pick a photo,
    add a message and send.
    Expected: the photo-library picker shows only the picked photo to the app
    (no full-library permission dialog beyond the system picker); the reply
    discusses the image.

19. **Links in replies.** Ask something that yields a link (e.g. in Debate
    mode ask for sources). Tap one.
    Expected: https links open in Safari; an http link, if one ever appears,
    does nothing. No image from a URL is ever rendered inside a reply.

### Layout and accessibility

20. **Dynamic Type XXL.** iOS Settings → Accessibility → Display & Text Size →
    Larger Text → drag to the largest non-accessibility size (XXL), then
    re-open Mercurius.
    Expected: the disclosure screen, a lesson with cards, the Settings screen
    and the chat input all remain readable and reachable; no clipped buttons,
    no text running off screen. Set it back afterwards.

21. **iPad landscape.** The build is universal, so install on an iPad (13"
    simulator is fine), rotate to landscape, and check the age gate, a lesson
    and Settings all lay out sanely.

### Store surfaces

22. **Every marketing link resolves.** On the Mac:

    ```bash
    for p in privacy terms support feedback get Get GET; do
      printf '%-8s ' "$p"; curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "https://trymercurius.com/$p"
    done
    # expect: 200 for each (a 301/302 is fine only if the target then returns 200)
    ```

    Also load each on the phone in Safari. `/support` must show
    `support@trymercurius.com`. `/get` must land on the App Store page for
    id 6773192313 (all three `/get` lines in `marketing/_redirects` point
    there since 2026-10-24).

23. **What's New matches the build.** Read the 2.3.0 What's New text in
    `APP_STORE_LISTING.md` §1 line by line against what you just rehearsed:
    first-launch flow, delete & start over, copyable session id, Privacy
    choices / Help & FAQ / Contact support, Home's next lesson and weekly
    goal, lessons saved across a reinstall, the two opt-in reminders, report
    with a reason, daily-limit and pause copy, https-only links and no remote
    images. Every bullet must
    describe something you saw in **this** build. Remove any bullet you could
    not verify before pasting it into App Store Connect.

24. **Reminder switches (optional feature).** Tap the flame in the chat
    header → Progress → Reminders → turn on "Weekly nudges (Wed & Sun)".
    Expected: the iOS notification permission prompt appears now (not at
    launch); allowing it schedules the local reminders; denying it shows the
    "Notifications are off for Mercurius…" hint instead of failing silently.
    Turning on one switch never turns on the other.

## When everything passes

- Record the build number you rehearsed and the date at the top of this file's
  PR description (or in the release notes), so the submitted build and the
  rehearsed build are provably the same.
- Continue with §6 of `APP_STORE_LISTING.md` ("Submit with phased release").

## Cleanup

- Kill switch is **off** (`GET /api/admin/kill-switch` → `disabled:false`).
- Proxy and its CA profile removed from the phone.
- Dynamic Type back to your normal size.
- `unset ADMIN OLD_ID` in the Mac shell.
