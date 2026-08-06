#!/usr/bin/env python3
"""Restore `resolved` + `integrity` in prime-agent's stripped package-lock.json.

Upstream commits the lockfile without tarball URLs, which breaks
prefetch-npm-deps. This script fetches the lockfile for a given upstream rev,
fills every node_modules entry missing `resolved` from the npm registry, and
writes the result minified to nix/package-lock.json.

Usage: python3 nix/fix-lockfile.py [rev]   (default: main)
"""
import concurrent.futures
import json
import pathlib
import sys
import urllib.request

REV = sys.argv[1] if len(sys.argv) > 1 else "main"
OUT = pathlib.Path(__file__).parent / "package-lock.json"
LOCK_URL = f"https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent/{REV}/package-lock.json"

with urllib.request.urlopen(LOCK_URL, timeout=60) as r:
    lock = json.load(r)
pkgs = lock["packages"]


def entry_name(key):
    return key.split("node_modules/")[-1]


todo = {
    k: (entry_name(k), v["version"])
    for k, v in pkgs.items()
    if k.startswith("node_modules/") and "resolved" not in v and not v.get("link")
}
print(f"{len(todo)} entries missing resolved", file=sys.stderr)


def fetch(item):
    key, (name, ver) = item
    url = f"https://registry.npmjs.org/{name.replace('/', '%2f')}"
    with urllib.request.urlopen(url, timeout=30) as r:
        dist = json.load(r)["versions"][ver]["dist"]
    return key, dist["tarball"], dist.get("integrity")


with concurrent.futures.ThreadPoolExecutor(max_workers=16) as ex:
    for key, tarball, integrity in ex.map(fetch, todo.items()):
        pkgs[key]["resolved"] = tarball
        if integrity:
            pkgs[key]["integrity"] = integrity

OUT.write_text(json.dumps(lock, separators=(",", ":")))
print(f"wrote {OUT}", file=sys.stderr)
