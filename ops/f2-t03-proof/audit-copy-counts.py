#!/usr/bin/env python3
"""Count COPY records in a *read-only pg_dump* snapshot. Never connects to any DB."""
import json
import re
import sys
from pathlib import Path

if len(sys.argv) != 3:
    raise SystemExit("usage: audit-copy-counts.py <pg_dump.sql> <counts.json>")
source, target = map(Path, sys.argv[1:])
counts = {}
current = None
matcher = re.compile(r'^COPY\s+(?:(?:"?public"?\.)?)("?([a-zA-Z_][a-zA-Z0-9_]*)"?)(?:\s|\()')
with source.open("r", encoding="utf-8") as f:
    for text in f:
        if current is not None:
            if text.rstrip("\r\n") == r"\.":
                current = None
            else:
                counts[current] += 1
            continue
        found = matcher.match(text)
        if found:
            current = found.group(2)
            if not current.startswith("taxonomy_"):
                raise ValueError(f"UNEXPECTED_AUDIT_TABLE:{current}")
            if current in counts:
                raise ValueError(f"DUPLICATE_COPY_SECTION:{current}")
            counts[current] = 0

required = {
    "taxonomy_f2_import_batches",
    "taxonomy_f2_import_segment_rows",
    "taxonomy_f2_import_product_rows",
    "taxonomy_concepts",
    "taxonomy_release_concepts",
}
missing = sorted(required - counts.keys())
if missing:
    raise ValueError(f"F2_AUDIT_TABLES_MISSING:{missing}")
if current is not None:
    raise ValueError("UNTERMINATED_PG_DUMP_COPY")
target.write_text(json.dumps(counts, ensure_ascii=False, sort_keys=True) + "\n")
print("F2_T03_PRODUCTION_COUNTS=" + json.dumps(counts, sort_keys=True))
