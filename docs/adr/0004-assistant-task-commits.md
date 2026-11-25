# ADR 0004: Member-started assistant tasks commit through the Room

Status: accepted

Members can start a private assistant conversation from an existing drawing. Sending instructions authorizes that task to edit this drawing while the browser is closed. The drawing first switches permanently to server-managed storage; this does not change its Space or sharing permissions.

Assistant commits use the same authoritative Room as human edits, with element revisions, task lease generations and control versions. A short Room queue serializes each commit with human changes and flushes. The scene, immutable operation receipt and private task event commit in one database transaction. Only then is the change broadcast. A natural-language completion is never evidence that an edit was saved.

Pause and new instructions fence later commits at the database lock. A completed commit can be reversed by a separate conflict-checked operation. Conversations remain private to the initiating member; scene changes follow drawing access.

ADR 0003 continues to govern ordinary `edit_drawing` proposals. Its Apply flow is separate from explicitly started assistant tasks. The deployment still requires one application process for Rooms.
