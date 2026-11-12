#!/usr/bin/env python3
"""Rotate TinyFish keys, run queries against api.search.tinyfish.ai, print compact JSONL."""
import json, sys, time, urllib.parse, urllib.request

KEYS = [l.strip() for l in open('/tmp/tfkeys.txt') if l.strip()]

def search(q, key, limit=10):
    url = "https://api.search.tinyfish.ai?" + urllib.parse.urlencode({"query": q, "limit": limit})
    req = urllib.request.Request(url, headers={"X-API-Key": key, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.load(r)

def main():
    queries = [l.strip() for l in open(sys.argv[1]) if l.strip() and not l.startswith('#')]
    out = open(sys.argv[2], 'a')
    for i, q in enumerate(queries):
        key = KEYS[i % len(KEYS)]
        try:
            d = search(q, key)
        except Exception as e:
            print(json.dumps({"query": q, "error": str(e)[:120]}), flush=True)
            out.write(json.dumps({"query": q, "error": str(e)[:120]}) + "\n"); out.flush()
            time.sleep(2); continue
        for r in d.get("results", []):
            rec = {"q": q, "pos": r.get("position"), "title": r.get("title"),
                   "url": r.get("url"), "snippet": (r.get("snippet") or "")[:300],
                   "site": r.get("site_name"), "date": r.get("date")}
            out.write(json.dumps(rec) + "\n")
            print(json.dumps(rec), flush=True)
        out.flush()
        time.sleep(1.5)
    out.close()

if __name__ == "__main__":
    main()
