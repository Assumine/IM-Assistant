"""Synthetic B: atomic JSON document, nested native records, turn context."""

import json
import os


class StoreB:
    format_name = "nested_json_document"
    native_prefix = "B::thread?"

    def __init__(self, root):
        self.path = root / "native-b.json"

    def load(self):
        if not self.path.exists():
            return None
        document = json.loads(self.path.read_text(encoding="utf-8"))
        state = document["engine"]
        state["conversations"] = {}
        for native_id, entry in document["threads"].items():
            value = entry["record"]
            value["native_id"] = native_id
            value["messages"] = entry["public_archive"]
            value["context"] = entry["active_turns"]
            state["conversations"][entry["alias"]] = value
        return state

    def save(self, state):
        document = {"engine":{k:v for k,v in state.items() if k != "conversations"}, "threads":{}}
        for alias, value in state["conversations"].items():
            document["threads"][value["native_id"]] = {
                "alias": alias, "record":{k:v for k,v in value.items() if k not in ("native_id","messages","context")},
                "public_archive":value["messages"], "active_turns":value["context"]}
        temporary = self.path.with_suffix(".tmp")
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(document, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, self.path)

    @staticmethod
    def new_context():
        return {"turns": [], "folds": []}

    @staticmethod
    def update_context(context, text):
        context["turns"].append({"utterance":text})

    @staticmethod
    def compact(context):
        context["folds"].append(len(context["turns"]))
        context["turns"] = [{"summary":"synthetic-turn-summary"}]


if __name__ == "__main__":
    from .control import serve
    serve(StoreB)
