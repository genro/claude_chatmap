"""Replay a past Claude Code transcript through chatmap, offline.

Every physical turn goes to the classifier (Haiku), which places it under a
topic only when certain. Every N physical turns, and at the end, the
reorganiser (Sonnet) regroups the turns into logical turns and topics.

Usage:
    python tools/classify_offline.py <transcript.jsonl> [--out out] [--limit N] [--every 10]

Writes <out>/<session>.json, in the shape of the mod's state, and
<out>/<session>.html, the grid page with that state embedded.
"""

import argparse
import json
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Turn:
    """One user prompt and everything up to the next prompt."""

    n: int
    prompt: str
    answer: str = ""
    tools: list[str] = field(default_factory=list)


class Transcript:
    """The main chain of a transcript file, split into turns."""

    def __init__(self, path: Path):
        self.path = path
        self.records = [json.loads(line) for line in path.open() if line.strip()]

    @property
    def session_id(self) -> str:
        return self.path.stem

    @property
    def title(self) -> str:
        titles = [r["customTitle"] for r in self.records if r.get("type") == "custom-title"]
        return titles[-1] if titles else self.session_id

    def main_chain(self) -> list[dict]:
        """The records from the root to the last leaf, compaction boundaries crossed."""
        by_uuid = {r["uuid"]: r for r in self.records if "uuid" in r}
        chained = [r for r in self.records if "uuid" in r and not r.get("isSidechain")]
        chain = []
        current = chained[-1]
        while current is not None:
            chain.append(current)
            parent = current.get("parentUuid") or current.get("logicalParentUuid")
            current = by_uuid.get(parent) if parent else None
        chain.reverse()
        return chain

    def prompt_text(self, record: dict) -> str | None:
        """The text the user typed, or None when the record is not a prompt."""
        if record.get("type") != "user" or record.get("isMeta") or "toolUseResult" in record:
            return None
        content = record["message"]["content"]
        if isinstance(content, str):
            text = content
        else:
            if any(b.get("type") == "tool_result" for b in content):
                return None
            text = "\n".join(b["text"] for b in content if b.get("type") == "text")
        text = text.strip()
        if not text or text.startswith("<"):
            return None
        return text

    def turns(self) -> list[Turn]:
        turns: list[Turn] = []
        for record in self.main_chain():
            text = self.prompt_text(record)
            if text is not None:
                turns.append(Turn(n=len(turns) + 1, prompt=text))
                continue
            if not turns or record.get("type") != "assistant":
                continue
            for block in record["message"]["content"]:
                if block.get("type") == "text" and block["text"].strip():
                    turns[-1].answer = block["text"].strip()
                elif block.get("type") == "tool_use":
                    turns[-1].tools.append(block["name"])
        return turns


class Model:
    """One model reached through `claude -p`, with a fixed system prompt."""

    def __init__(self, name: str, prompt_path: Path):
        self.name = name
        self.system = prompt_path.read_text()
        self.workdir = tempfile.mkdtemp(prefix="chatmap-")

    def ask(self, payload: dict) -> dict:
        """The JSON object the model answers; ValueError when it answers none."""
        result = subprocess.run(
            [
                "claude", "-p",
                "--model", self.name,
                "--system-prompt", self.system,
                "--tools", "",
                "--setting-sources", "",
                "--strict-mcp-config",
                "--no-session-persistence",
            ],
            input=json.dumps(payload, ensure_ascii=False),
            capture_output=True,
            text=True,
            cwd=self.workdir,
            timeout=600,
        )
        if result.returncode != 0:
            raise RuntimeError(f"claude -p exited {result.returncode}: {result.stderr.strip()}")
        output = result.stdout
        start, end = output.find("{"), output.rfind("}")
        if start < 0 or end < start:
            raise ValueError(f"no JSON object in the output: {output[:200]}")
        return json.loads(output[start : end + 1])


class ChatMap:
    """The state the mod keeps: physical turns, logical turns, topics."""

    RECENT = 4
    EXCERPT = 400
    PROMPT_TEXT = 1500
    ANSWER_EDGE = 600
    REVISABLE = 2

    def __init__(self, transcript: Transcript, classifier: Model, reorganiser: Model, short_chars: int):
        self.transcript = transcript
        self.classifier = classifier
        self.reorganiser = reorganiser
        self.short_chars = short_chars
        self.topics: dict[str, dict] = {}
        self.physical: list[dict] = []
        self.logical: list[dict] = []
        self.primary: str | None = None
        self.passes = 0
        self.topic_count = 0
        self.texts: dict[int, Turn] = {}

    def answer_edges(self, answer: str) -> str:
        if len(answer) <= 2 * self.ANSWER_EDGE:
            return answer
        return f"{answer[: self.ANSWER_EDGE]}\n[...]\n{answer[-self.ANSWER_EDGE :]}"

    def model_turn(self, turn: Turn) -> dict:
        return {
            "n": turn.n,
            "prompt": turn.prompt[: self.PROMPT_TEXT],
            "answer": self.answer_edges(turn.answer),
            "tools": sorted(set(turn.tools)),
        }

    @property
    def pending(self) -> list[dict]:
        """The physical turns no logical turn covers yet."""
        covered = self.logical[-1]["physical"][-1] if self.logical else 0
        return [p for p in self.physical if p["n"] > covered]

    def is_short(self, turn: Turn) -> bool:
        return bool(self.physical) and not turn.tools and len(turn.prompt) < self.short_chars

    def classify(self, turn: Turn) -> dict:
        entry = {
            "n": turn.n,
            "prompt": turn.prompt[: self.EXCERPT],
            "answer": turn.answer[-self.EXCERPT :],
            "tools": sorted(set(turn.tools)),
            "short": False,
            "haiku": [],
        }
        self.texts[turn.n] = turn
        if self.is_short(turn):
            entry.update(short=True, haiku=list(self.physical[-1]["haiku"]))
        elif self.topics:
            topics = []
            for topic_id, topic in self.topics.items():
                recent = [lt for lt in self.logical if topic_id in lt["topics"]][-self.RECENT :]
                topics.append({**topic, "id": topic_id, "recent": [{"prompt": lt["prompt"], "outcome": lt["outcome"]} for lt in recent]})
            changes = self.classifier.ask({"topics": topics, "turn": self.model_turn(turn)})
            unknown = [t for t in changes["assign"] if t not in self.topics]
            if unknown:
                raise ValueError(f"classifier named unknown topics {unknown}")
            entry["haiku"] = list(changes["assign"])
        self.physical.append(entry)
        return entry

    def reorganise(self) -> None:
        revisable = self.logical[-self.REVISABLE :]
        kept = self.logical[: len(self.logical) - len(revisable)]
        span = [n for lt in revisable for n in lt["physical"]] + [p["n"] for p in self.pending]
        payload = {
            "topics": [{**t, "id": i} for i, t in self.topics.items()],
            "primary": self.primary,
            "revisable": [{k: lt[k] for k in ("physical", "label", "prompt", "outcome", "topics")} for lt in revisable],
            "new": [{**self.model_turn(self.texts[p["n"]]), "haiku": p["haiku"] or None} for p in self.pending],
            "next_topic_id": f"t{self.topic_count + 1}",
        }
        result = self.reorganiser.ask(payload)

        covered = [n for lt in result["logical"] for n in lt["physical"]]
        if covered != span:
            raise ValueError(f"logical turns cover {covered}, expected {span}")
        topics = {t["id"]: {"title": t["title"], "description": t["description"]} for t in result["topics"]}
        merge = {m["from"]: m["into"] for m in result.get("merge", [])}
        for logical in kept:
            logical["topics"] = list(dict.fromkeys(merge.get(t, t) for t in logical["topics"]))
        for logical in kept + result["logical"]:
            unknown = [t for t in logical["topics"] if t not in topics]
            if unknown:
                raise ValueError(f"logical turn {logical['physical']} names unknown topics {unknown}")
        if result["primary"] not in topics:
            raise ValueError(f"primary {result['primary']} is not a topic")

        self.passes += 1
        for logical in result["logical"]:
            logical["pass"] = self.passes
        self.topics = topics
        self.topic_count = max([self.topic_count] + [int(i[1:]) for i in topics])
        self.primary = result["primary"]
        self.logical = kept + result["logical"]

    def agreement(self) -> dict:
        """How often the classifier's certain placements match the reorganiser's."""
        final = {n: lt["topics"] for lt in self.logical for n in lt["physical"]}
        placed = [p for p in self.physical if p["haiku"] and not p["short"]]
        right = [p for p in placed if set(p["haiku"]) <= set(final.get(p["n"], []))]
        classified = [p for p in self.physical if not p["short"]]
        return {"classified": len(classified), "placed": len(placed), "agree": len(right)}

    def as_dict(self) -> dict:
        return {
            "version": 2,
            "session": self.transcript.session_id,
            "title": self.transcript.title,
            "models": {"classifier": self.classifier.name, "reorganiser": self.reorganiser.name},
            "primary": self.primary,
            "topics": self.topics,
            "logical": self.logical,
            "physical": self.physical,
            "agreement": self.agreement(),
        }


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description="Replay a past transcript through chatmap.")
    parser.add_argument("transcript", type=Path)
    parser.add_argument("--out", type=Path, default=root / "out")
    parser.add_argument("--limit", type=int, help="replay only the first N physical turns")
    parser.add_argument("--every", type=int, default=10, help="reorganise every N physical turns")
    parser.add_argument("--classifier", default="haiku")
    parser.add_argument("--reorganiser", default="sonnet")
    parser.add_argument("--short-chars", type=int, default=20)
    args = parser.parse_args()

    transcript = Transcript(args.transcript)
    chatmap = ChatMap(
        transcript,
        Model(args.classifier, root / "prompts" / "classifier.md"),
        Model(args.reorganiser, root / "prompts" / "reorganizer.md"),
        args.short_chars,
    )
    turns = transcript.turns()[: args.limit]

    for turn in turns:
        entry = chatmap.classify(turn)
        mark = "short" if entry["short"] else ",".join(entry["haiku"]) or "unclassified"
        print(f"{entry['n']:>4}  {mark:<14} {turn.prompt[:60]!r}", flush=True)
        if len(chatmap.pending) >= args.every:
            chatmap.reorganise()
            print(f"      pass {chatmap.passes}: {len(chatmap.logical)} logical turns, {len(chatmap.topics)} topics", flush=True)
    if chatmap.pending:
        chatmap.reorganise()

    args.out.mkdir(parents=True, exist_ok=True)
    data = json.dumps(chatmap.as_dict(), ensure_ascii=False, indent=2)
    (args.out / f"{transcript.session_id}.json").write_text(data)
    template = (root / "tools" / "grid.html").read_text()
    viewer = template.replace("/*DATA*/null", data.replace("</", "<\\/"))
    (args.out / f"{transcript.session_id}.html").write_text(viewer)
    a = chatmap.agreement()
    print(f"{len(chatmap.topics)} topics, {len(chatmap.logical)} logical / {len(turns)} physical turns; "
          f"classifier placed {a['placed']}/{a['classified']}, agreeing {a['agree']}")


if __name__ == "__main__":
    main()
