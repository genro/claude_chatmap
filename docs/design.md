# Design notes

Requires Claude Code 2.1.287+ (mods). Checked against the mod API of 2.1.288.

## Premise
A conversation has one primary topic and secondary topics that pollute it.
The primary topic is often recognisable only afterwards.

## Classification
- `prompt.submit` gives the user text; `turn.complete` fires at the end of the turn.
- `$.model.complete({ model, prompt })` runs the classifier (Haiku).
- Optional: Sonnet every N turns, or when the pane opens, to revise titles and descriptions.
- Model choice to be measured offline on 3-4 past transcripts (`~/.claude/projects/`) before writing the mod.

## State
- Incremental JSON kept by the mod (`$.state` for the session, `$.store` across sessions).
- Every entry keeps the uuids of the messages it summarises.
- Short turns ("ok", "go") are merged into the previous entry.
- A turn may belong to more than one topic.

## Classifier input
- Topic list: title and description.
- Last 4 entries per topic, each with its turn number.
- The new turn.
- The classifier returns only changes; the mod applies them to the full JSON.

## Dropping a topic
- A `session.compact` hook returns the messages to keep; messages kept with their `handle` stay whole.
- `$.session.compact()` starts it from the mod.
- A turn shared with a kept topic is kept whole.
- Cost: prompt cache invalidated from the first removed message onwards.

## Moving a topic
- The mod writes the topic's messages to a file (`$.session.messages()`, `$.fs.write`), then drops them.
- A new conversation starts from that file.

## UI
- A mod `Pane`: grid of topics (said / done / answered) with Keep / Drop / Move buttons (no checkbox element; a Button toggles).
- Lanes: one per topic, turns as dots, the conversation order as a line across lanes.
- A preview of what will be removed before applying.

## Not verified
- How the desktop app shows a conversation after messages are removed.
- Whether the mod can start a new session by itself.
