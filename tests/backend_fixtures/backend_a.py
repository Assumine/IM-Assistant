"""Synthetic A: SQLite rows and opaque slash/Unicode native identifiers."""

import json
import sqlite3


class StoreA:
    format_name = "sqlite_rows"
    native_prefix = "原生 A / "

    def __init__(self, root):
        self.db = sqlite3.connect(root / "native-a.sqlite")
        self.db.execute("CREATE TABLE IF NOT EXISTS objects (key TEXT PRIMARY KEY, value TEXT NOT NULL)")

    def load(self):
        rows = dict(self.db.execute("SELECT key, value FROM objects"))
        if not rows:
            return None
        state = json.loads(rows.pop("metadata"))
        state["conversations"] = {key[5:]: json.loads(value) for key, value in rows.items() if key.startswith("conv:")}
        return state

    def save(self, state):
        metadata = {k:v for k,v in state.items() if k != "conversations"}
        with self.db:
            self.db.execute("DELETE FROM objects")
            self.db.execute("INSERT INTO objects VALUES (?,?)", ("metadata", json.dumps(metadata)))
            self.db.executemany("INSERT INTO objects VALUES (?,?)", [
                ("conv:"+key, json.dumps(value)) for key,value in state["conversations"].items()])

    @staticmethod
    def new_context():
        return {"token_cells": [], "compaction_index": 0}

    @staticmethod
    def update_context(context, text):
        context["token_cells"].extend(text.split())

    @staticmethod
    def compact(context):
        context["token_cells"] = ["synthetic-summary"]
        context["compaction_index"] += 1


if __name__ == "__main__":
    from .control import serve
    serve(StoreA)
