# chatmap

A Claude Code plugin (mod) that maps a conversation by topic.

Status: M1 in use. Requires Claude Code 2.1.286+.

- Every prompt is recorded as a physical turn; a small model (Haiku) places it under a topic when it is certain.
- A larger model (Sonnet) regroups the turns into logical turns, with a short label and the request completed with the answers given, and names the topics.
- sourcerer-link, one local service per machine, shows the map: a grid of topics and a grid of turns, live.
- chatmap is off in every chat until turned on from the footer.
- `/chatmap` reorganises and prints the map's URL; `/chatmap full` rebuilds the map from scratch.

Design notes: [docs/design.md](docs/design.md).
