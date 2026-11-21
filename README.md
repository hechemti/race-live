# Race Day Live

Live race tracker you can run from your phone's browser. No app or account needed.

- `run.html#t=<code>`: the **runner** page. Open it on the phone you carry. It reads GPS and shares updates.
- `index.html#t=<code>`: the **friends'** page. It shows a live map, distance, pace, km splits, projected finish, battery, and lets friends send cheers that are read out loud on the runner's phone.
- `index.html#demo` shows a made-up race so you can see how it looks.
- `run.html#t=<code>&sim` is a test mode with fake GPS at 10× speed.

Updates go through [ntfy.sh](https://ntfy.sh), a free public relay (250 messages a day per network). The runner page spaces its updates (about every 30–50 s) so a half marathon fits in that budget. Anyone who has the link (and the code in it) can see the location, so only share it with friends.

Phone browsers stop GPS when the screen locks. The runner page keeps the screen awake, but on iPhone also set Auto-Lock to Never for the race.
