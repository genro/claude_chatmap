# Design notes

Requires Claude Code 2.1.286+ (mods). Checked against the mod API of 2.1.286.
The manifest has no field for a minimum version: the requirement is documentation only.

## Premise
A conversation has one primary topic and secondary topics that pollute it.
The primary topic is often recognisable only afterwards.

## Milestones
- M1, collect and classify: physical turns recorded live, the Haiku classifier, the Sonnet reorganiser, the state in `$.state`, a local server with the map page.
- M2, visualise further: persistence across sessions, import of the turns a chat had before the mod loaded.
- M3, use: decided after M2. Drop, move, the replacement message, engine compaction.

## Files
- `hooks/register.tsx`: the mod.
- `types/index.d.ts`: the contract of its `$.state`.
- `prompts/classifier.md`, `prompts/reorganizer.md`: the two model prompts, read at run time.
- `server/chatmap_server.py`: the local server, stdlib only.
- `tools/grid.html`: the map page, served by the server and used by the offline script.
- `tools/classify_offline.py`: replays a past transcript through the same prompts.

## Turns
- A physical turn is one user prompt and everything up to the next prompt.
- A logical turn is one or more consecutive physical turns that pursue one request: the request, the clarifying questions and their answers, the confirmations, the follow-ups.
- A logical turn carries a label (3 to 10 words), a completed prompt (the request with the answers folded in) and an outcome.
- A block is a run of consecutive logical turns that pursue one goal; its turns may touch several topics.
- A topic groups logical turns; they need not be consecutive. Its title names the subject, never a generic word.
- Topic titles are English; labels, blocks, descriptions, completed prompts and outcomes are in the language of the conversation.

## Recording
- `prompt.submit` records a physical turn as `running` and publishes the map at once.
- Only prompts typed by the person are recorded: origin `composer`, `bridge` or `sdk`. Task notifications and messages from other sessions are not.
- A prompt typed while a turn runs (`turnId` set) is appended to the running turn's prompt.
- Slash commands are not recorded.
- `turn.complete` fills the answer (its first and last 600 characters) and the tools, and queues the turn. Subagent turns (`agentId` set) are ignored.
- A turn with no tools and a prompt under 20 characters is short: it takes the topic of the previous turn without a model call.
- At load the mod drops turns recorded from notifications before this filter existed.

## Classification
- A timer (`$.clock.every`, 1 s) works the queue; one lane serialises the work.
- Classifier (Haiku), every queued turn: places the turn under an existing topic only when certain, else leaves it unclassified. It never creates a topic.
- The classifier also answers `newSubject`: true when the turn moves to a subject no topic covers.
- Reorganiser (Sonnet) runs when 10 physical turns wait, when the classifier says `newSubject`, on ↻ and on `/chatmap`.
- It works incrementally: the topics, the last 2 logical turns and the waiting physical turns; from the first logical turn without a label when one exists.
- It writes logical turns with label, completed prompt, outcome, topics and block; creates, renames and merges topics; names the primary topic.
- Rebuild (`/chatmap full` or the page button) rebuilds everything from all physical turns, keeping only the topics the user edited.
- A topic edited by the user is `fixed`: the reorganiser keeps its id, title and description and never merges it away.
- `$.model.complete({ model, system, prompt, maxTokens })` runs both models; the reply's JSON is checked and a reply that names unknown topics or misses turns is refused with a toast.

## Server and page
- `session.start` spawns the server (`$.process.spawn`); it lives as long as the mod.
- The port is derived from the session id (41000 to 48999), so the page stays valid across mod reloads; the server retries a busy port for 10 s.
- The mod posts the whole map (`POST /state`) after every change; open pages receive it as a server-sent event (`GET /events`), and get the current map on connect.
- The page queues actions (`POST /action`): reorganise, rebuild, edit a topic. The mod takes them every second (`GET /actions`).
- `/chatmap` reorganises and returns the URL; the Browser pane opens it beside the chat.
- The page follows the app's light or dark theme.

## Page
- Topics grid on top (own scroll): code (T1, T2…), title, description, count of logical turns; ✎ edits title and description.
- Turns grid below, one line per logical turn: one narrow column per topic (the turn's columns filled with the topic colour), the label, the range of physical turns, ▸ for the full request, outcome and physical turns.
- A topic selected in the top grid filters the turns.
- Turns awaiting the reorganiser are blue; a running turn is orange; ✗ marks a turn the classifier placed differently from the reorganiser.
- Cluster joins consecutive logical turns of one block into one row whose text is their labels in sequence.

## State
- `$.state` (`chatmap`): topics, topic counter, primary topic, physical turns, logical turns, pass counter.
- Turns are numbered by position, the next number after the last recorded; numbers of dropped turns are not reused.
- `$.session.messages()` returns no uuid; `handle` exists only inside a `session.compact` hook.

## Offline measurement
- `tools/classify_offline.py <transcript.jsonl>` replays a past transcript: the classifier on every turn, the reorganiser every 10 turns and at the end.
- Models run through `claude -p` with the prompt files as system prompt, no tools, no settings, no session persistence.
- It writes `out/<session>.json` and `out/<session>.html` (the grid page with the map embedded).
- Result on 4 sessions (199 physical turns): 3 to 6 physical turns per logical turn; where Haiku was certain, Sonnet agreed in 102 of 116 placements.

## Desktop findings (2.1.286)
- `$.ui.status` is text only; `Select` is not drawn in `SessionMode`; the `PromptHint` site is not drawn; the `AbovePrompt` band aligns Buttons to the right whatever `justifyContent` says.
- A render hook must not write `$.state`: the write is denied and the engine draws its own placeholder.
- Hot reload does not follow a symbolic link in the dev-mods folder: the mod there is a copy.
- A topic chooser in the footer and prompt prefixes (`°`, `@@`, ...) were tried and dropped: the reorganiser names topics itself and the user edits them in the page.

## Dropping a topic (M3)
- A `session.compact` hook returns the messages to keep; messages kept with their `handle` stay whole.
- `$.session.compact()` starts it from the mod (`trigger: 'plugin'`), between turns.
- In the hook, turn N is the N-th block of `e.messages`, split by the same rule as the recording.
- If a prompt text does not match the saved one, the hook returns `{ skip }` and nothing changes.
- Only whole turns are removed, so a `tool_use` never loses its `tool_result`.
- A turn shared with a kept topic is kept whole.
- A message without `handle` replaces the removed turns: it says which topics were removed or moved, and where the moved file is.
- Cost: prompt cache invalidated from the first removed message onwards.

## Engine compaction (M3)
- `/compact` (`trigger: 'manual'`) and automatic compaction (`'auto'`) also raise `session.compact`.
- The mod lets the engine compact, then marks the summarised turns as compacted.
- A compacted turn can no longer be dropped or moved.

## Moving a topic (M3)
- The mod writes the topic's messages to a file (`$.session.messages()`, `$.fs.write`), then drops them.
- No mod API call starts a new conversation: `$.session.send` reaches only existing sessions.
- The page shows a prompt to paste into a new conversation, which reads the file.

## Not verified
- How the desktop app shows a conversation after messages are removed.
