"""Verify imported public source bytes against the immutable upstream inventory."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import zipfile

from tools.native_baseline import ROOT, provenance


def archive_inventory(archive):
    record = provenance()
    if hashlib.sha256(archive.read_bytes()).hexdigest() != record["archive_sha256"]:
        raise ValueError("Upstream archive checksum mismatch")
    files = {}
    with zipfile.ZipFile(archive) as source:
        for item in source.infolist():
            if item.is_dir():
                continue
            relative = PurePosixPath(*PurePosixPath(item.filename).parts[1:])
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError("Unsafe upstream archive entry")
            content = source.read(item)
            entry = {"sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content)}
            if (item.external_attr >> 16) & 0o170000 == 0o120000:
                entry["symlink"] = content.decode()
            files[str(relative)] = entry
    return {"upstream_commit": record["commit"], "files": files}


def verify():
    inventory = json.loads((ROOT / "upstream/source-files.json").read_text(encoding="utf-8"))
    assert inventory["upstream_commit"] == provenance()["commit"]
    source = (ROOT / "opencode").resolve()
    ledger = json.loads((ROOT / "upstream/patches.json").read_text(encoding="utf-8"))
    assert ledger["upstream_commit"] == inventory["upstream_commit"]
    patches = {}
    for patch in ledger["patches"]:
        assert patch["reason"] and patch["verification_commands"], patch["id"]
        for entry in patch["files"]:
            relative = PurePosixPath(entry["path"])
            assert not relative.is_absolute() and ".." not in relative.parts
            assert not {"node_modules", ".turbo", ".reports"}.intersection(relative.parts), entry["path"]
            assert relative.parts[0] != "runtime", entry["path"]
            assert relative.suffix not in {".log", ".db", ".sqlite", ".sqlite3"}, entry["path"]
            assert entry["path"] not in patches, "Consolidate the final hash for each patched file"
            patches[entry["path"]] = entry
    links = {link["path"]: link for link in provenance()["platform_symlinks"]}
    for relative, entry in inventory["files"].items():
        target = source / relative
        assert target.resolve().is_relative_to(source), relative
        expected = patches.get(relative, entry)["sha256"]
        if "symlink" in entry:
            assert links[relative]["target"] == entry["symlink"]
            original = (target.parent / entry["symlink"]).resolve()
            assert original.is_relative_to(source)
            expected = hashlib.sha256(original.read_bytes()).hexdigest()
        assert target.is_file(), f"Missing upstream source: {relative}"
        assert hashlib.sha256(target.read_bytes()).hexdigest() == expected, f"Changed upstream source: {relative}"
    for relative, entry in patches.items():
        target = source / relative
        assert target.resolve().is_relative_to(source), relative
        assert entry["action"] in {"modified", "added"}
        assert (relative in inventory["files"]) == (entry["action"] == "modified"), relative
        assert target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == entry["sha256"], relative
    return {"source_files": len(inventory["files"]), "verified": True, "unchanged": not bool(patches),
            "declared_product_files": len(patches),
            "materialized_windows_symlinks": sum(x["materialized"] for x in links.values())}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory-from", type=Path)
    args = parser.parse_args()
    if args.inventory_from:
        data = archive_inventory(args.inventory_from)
        (ROOT / "upstream/source-files.json").write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(verify()))
