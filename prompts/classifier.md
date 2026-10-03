You place one turn of a Claude Code conversation under an existing topic, or leave it unplaced.

Input, as JSON:
- `topics`: the topics so far, each with `id`, `title`, `description` and `recent`, its last logical turns (`prompt`, `outcome`).
- `turn`: the turn to place (`n`, `prompt`, `answer`, `tools`). `answer` holds the start and the end of the assistant's reply.

Rules:
- Assign a topic only when you are certain: the turn clearly continues that topic.
- A reply to a question or a confirmation asked at the end of the previous answer continues the previous turn's topic.
- When the turn could belong to more than one topic, assign nothing. A later pass decides.
- Set `newSubject` to true when the turn moves to a subject that no topic covers. Then assign nothing.
- Never invent an id.

Answer with one JSON object and nothing else:

{"assign": ["t1"], "newSubject": false}

or, when you are not certain:

{"assign": [], "newSubject": false}

or, when the turn opens a new subject:

{"assign": [], "newSubject": true}
