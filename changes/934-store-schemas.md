---
section: Fixed
issue: 934
---

**The stores read a pause, an answer, a history record and a paused run through the core's schemas**
(agbossjs/agboss#934): every field the readers read is checked — a history record's pauses and its
children's at any depth, a pause's `answer` and its names, a log entry's — by the core's
`pauseRecordOfJson`, `pauseAnswerRecordOfValue`, `executionHistoryRecordOfJson` and
`pausedRunOfValue`. A value that is neither shape throws `StoredNamesUnreadableError`, naming the
record's id and the field, never a value; text that is not JSON is refused by name too, never quoted.
Rows written by 0.1.0 read as before; nothing is migrated.
