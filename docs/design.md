# Design notes

Requires Claude Code 2.1.286+ (mods). Checked against the mod API of 2.1.286.
The manifest has no field for a minimum version: the requirement is documentation only.

## Premise
A conversation has one primary topic and secondary topics that pollute it.
The primary topic is often recognisable only afterwards.

## Milestones
- M1, collect and classify: physical turns recorded live, the Haiku classifier, the Sonnet reorganiser, the state in `$.state`, the map page served by sourcerer-link.
- M2, visualise further: done so far, persistence across app restarts and import of the turns a chat had before the mod loaded.
- M3, use: decided after M2. Drop, move, the replacement message, engine compaction.

## Files
- `hooks/register.tsx`: the mod.
- `types/index.d.ts`: the contract of its `$.state`.
- `prompts/classifier.md`, `prompts/reorganizer.md`: the two model prompts, read at run time.
- `tools/grid.html`: the map page, served by sourcerer-link and used by the offline script.
- `tools/classify_offline.py`: replays a past transcript through the same prompts.

## Turns
- A physical turn is one user prompt and everything up to the next prompt.
- A logical turn is one or more consecutive physical turns that pursue one request: the request, the clarifying questions and their answers, the confirmations, the follow-ups.
- A logical turn carries a label (3 to 10 words), a completed prompt (the request with the answers folded in) and an outcome.
- A block is a run of consecutive logical turns that pursue one goal; its turns may touch several topics.
- A topic groups logical turns; they need not be consecutive. Its title names the subject, never a generic word.
- Topic titles are English; labels, blocks, descriptions, completed prompts and outcomes are in the language of the conversation.

## On and off
- chatmap starts off in every chat: no recording, no model calls, no timer.
- A Button in the footer (`SessionMode` site) reads `chatmap off` or `chatmap on`; the footer's own mode labels are drawn beside it.
- The desktop app loads the mod when the chat's process starts, at the first message: the Button appears only then.
- Turning on asks for confirmation (`$.ui.ask`); a dismissed dialog keeps it off. `/chatmap` on a chat that is off asks the same.
- Turning on restores the saved map, or imports the past turns when there is none, then starts the timer. It needs a host (see Hosts): if none answers and none can be started, chatmap stays off with a toast.
- Turning on from the footer or with `/chatmap` asks the model to open the map in the Browser pane: a mod cannot open the pane itself. The model's `preview_start` loads the page in a hidden pane; no tool shows it, the user opens it from the card in the transcript.
- Turning off stops the timer and the recording.
- The flag `enabled` is saved with the map by the host; a map saved without it is off.

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

## Hosts
- The map lives in a host: one local process for all the chats of the machine. Target design; today (2026-10-05) the code posts to sourcerer-link only.
- **chatmap's own host**: a server in this repo, Python standard library only, on `127.0.0.1:40998`, data in chatmap's own folder. chatmap needs nothing else installed and knows nothing of Sourcerer.
- **sourcerer-link** (repo `genro/sourcerer-link`), when installed, hosts chatmap's logic itself on `127.0.0.1:40999`, so the machine runs one process for all its plugins instead of one per plugin.
- The host logic is one module of this repo, separate from its HTTP front: chatmap's own server wraps it in `http.server`; sourcerer-link loads the same module through an adapter. One code, two fronts.
- Both hosts speak the same routes (below); one protocol test suite runs against both.
- Choice, at every turning on: the mod asks `40999`; if sourcerer-link answers, it uses it; otherwise it uses `40998`, and starts chatmap's own host when nothing answers there.
- Lifecycle of chatmap's own host: started by the mod (`$.process.spawn`), it ends with the chat that started it; any chat that is on and finds no host at its next tick starts it again. The maps are on disk, so a restart loses nothing; open pages reconnect.
- Optional `install` for chatmap's own host (macOS LaunchAgent) for whoever wants it always on.

## Server and page
- Turning on registers the chat (`POST /sessions/<id>`: working directory, title, path of `tools/grid.html`).
- The mod posts the whole map (`POST /sessions/<id>/state`) after every change; the host saves it and sends it to the open pages as a server-sent event.
- The page queues actions (`POST /s/<id>/action`): reorganise, rebuild, edit a topic. The mod takes them every second (`GET /sessions/<id>/inbox`).
- `/` lists the chats; `/s/<id>/` is one chat's map.
- When the host does not answer, the footer reads `chatmap on · link off`; the next publish sends the whole map again.
- `/chatmap` reorganises and returns the URL.
- The page follows the app's light or dark theme.

## Page
- Topics grid on top (own scroll): code (T1, T2…), title, description, count of logical turns; ✎ edits title and description.
- Turns grid below, one line per logical turn: one narrow column per topic (the turn's columns filled with the topic colour), the label, the range of physical turns, ▸ for the full request, outcome and physical turns.
- A topic selected in the top grid filters the turns.
- Turns awaiting the reorganiser are blue; a running turn is orange; ✗ marks a turn the classifier placed differently from the reorganiser.
- Cluster joins consecutive logical turns of one block into one row whose text is their labels in sequence.

## State
- `$.state` (`chatmap`): topics, topic counter, primary topic, physical turns, logical turns, pass counter.
- The host saves every posted map in its data folder (`chatmap/<session>.json`). Turning on restores it; only a chat with no saved map imports its past turns from the transcript.
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
