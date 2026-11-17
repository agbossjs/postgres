---
section: Changed
issue: 1260
---

**The live-lease refusal names the environment's switch** (agbossjs/agboss#1260, #1104):
`PostgresLiveLeasesError`'s message now says `allowLiveLeases` in the connection's settings and
`postgresAllowLiveLeases` in the application's environment next to the command's flag, so an
operator whose start with `SchemaSetup.MigrateOnStart` is refused knows the switch without reading
the README. Only the text changes.
