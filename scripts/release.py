#!/usr/bin/env python3
"""Release helpers: write the plugin's meta.json, and add a version to the plugin repository manifest."""
import argparse
import datetime
import hashlib
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.0000000Z")


def meta(args):
    data = json.loads((ROOT / "meta.json").read_text())
    data.update(version=args.version, changelog=args.changelog, timestamp=now())
    pathlib.Path(args.out).write_text(json.dumps(data, indent=2) + "\n")


def manifest(args):
    template = json.loads((ROOT / "meta.json").read_text())
    path = ROOT / "manifest.json"
    repo = json.loads(path.read_text()) if path.exists() else []
    entry = next((p for p in repo if p["guid"] == template["guid"]), None)
    if entry is None:
        entry = {"guid": template["guid"], "versions": []}
        repo.append(entry)
    for key in ("name", "description", "overview", "owner", "category", "imageUrl"):
        if key in template:
            entry[key] = template[key]
    checksum = hashlib.md5(pathlib.Path(args.zip).read_bytes()).hexdigest()
    entry["versions"] = [v for v in entry["versions"] if v["version"] != args.version]
    entry["versions"].insert(0, {
        "version": args.version,
        "changelog": args.changelog,
        "targetAbi": template["targetAbi"],
        "sourceUrl": args.url,
        "checksum": checksum,
        "timestamp": now(),
    })
    path.write_text(json.dumps(repo, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    m = sub.add_parser("meta")
    m.add_argument("--version", required=True)
    m.add_argument("--changelog", required=True)
    m.add_argument("--out", required=True)
    r = sub.add_parser("manifest")
    r.add_argument("--version", required=True)
    r.add_argument("--changelog", required=True)
    r.add_argument("--zip", required=True)
    r.add_argument("--url", required=True)
    args = parser.parse_args()
    {"meta": meta, "manifest": manifest}[args.command](args)
