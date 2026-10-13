#!/usr/bin/env python3
"""CI-COST-02 routing. Unknown backend changes keep the isolated PG18 gate."""
import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import subprocess

@dataclass(frozen=True)
class Plan:
    full_regression: bool
    pg18_required: bool
    reason: str

def parse_nul_diff(raw):
    if not raw or not raw.endswith(b"\0"):
        return None
    try:
        paths = raw[:-1].decode("utf-8", errors="strict").split("\0")
    except UnicodeDecodeError:
        return None
    if any(not path for path in paths):
        return None
    return paths

def related_or_unknown(path):
    # Invalid/noncanonical paths never enter the unrelated whitelist.
    if (not isinstance(path, str) or not path or path.startswith("/")
            or "\\" in path or any(p in ("", ".", "..") for p in path.split("/"))):
        return True
    lower = path.casefold()
    # Protected rules precede whitelist roots, including SQL under docs/test/src.
    if (lower.endswith(".sql")
            or any(token in lower for token in
                   ("dou-clean-02", "dou-historical-cleanup", "publication-scope", "rls"))
            or lower.startswith(("migrations/", "src/infrastructure/database/",
                                 "src/modules/auth/", ".github/"))
            or lower in ("package.json", "package-lock.json", ".npmrc", ".nvmrc",
                         "tsconfig.json", "tsconfig.build.json")
            or lower.startswith(("tsconfig.", "dockerfile"))
            or "/dockerfile" in lower):
        return True
    if path.startswith(("src/", "test/", "docs/")):
        return False
    if path in ("README.md", "AGENTS.md", ".gitignore"):
        return False
    return True

def make_plan(kind, event, draft, changed_paths=None):
    if kind not in ("backend", "web") or event not in ("pull_request", "push"):
        raise ValueError("unsupported CI kind/event")
    if not isinstance(draft, bool):
        raise ValueError("draft must be a boolean")
    if event == "pull_request" and draft:
        return Plan(False, False, "draft-fast-only")
    if kind == "web":
        return Plan(True, False, "full-web")
    if event == "push":
        return Plan(True, True, "full-main")
    if not changed_paths:
        return Plan(True, True, "diff-unproven")
    if any(related_or_unknown(path) for path in changed_paths):
        return Plan(True, True, "related-or-unknown-path")
    return Plan(True, False, "proven-unrelated-paths")

def git_changed_paths(base, head):
    # Pass only validated SHA arguments to git; never shell-expand PR data.
    if not all(re.fullmatch(r"[0-9a-fA-F]{40}", sha or "") for sha in (base, head)):
        return None
    try:
        subprocess.run(
            ["git", "fetch", "--no-tags", "--depth=1", "origin", base, head],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=45)
        diff = subprocess.run(
            ["git", "diff", "--no-renames", "--name-only", "-z", base, head],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
        return parse_nul_diff(diff.stdout)
    except (OSError, subprocess.SubprocessError):
        # No captured git stderr/URL/credentials are emitted.
        return None

def publish(plan):
    outputs = (
        f"full_regression={str(plan.full_regression).lower()}\n"
        f"pg18_required={str(plan.pg18_required).lower()}\n")
    if os.environ.get("GITHUB_OUTPUT"):
        with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as handle:
            handle.write(outputs)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a", encoding="utf-8") as handle:
            handle.write(
                f"### CI-COST-02\n\nFull regression: **{plan.full_regression}**; "
                f"PG18: **{plan.pg18_required}**; reason: `{plan.reason}`.\n\n"
                "Draft fast checks do not approve a merge. Mark ready for review "
                "to run the full regression. Never rerun DRAFT_FAST_ONLY to fix it.\n")
    print(json.dumps(plan.__dict__, sort_keys=True))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", choices=("backend", "web"), required=True)
    parser.add_argument("--require-full", action="store_true")
    args = parser.parse_args()
    event = os.environ.get("CI_EVENT_NAME", "")
    draft_text = os.environ.get("CI_DRAFT", "")
    if draft_text not in ("true", "false"):
        parser.error("CI_DRAFT must be true or false")
    draft = draft_text == "true"
    if args.require_full:
        plan = make_plan(args.kind, event, draft)
        if not plan.full_regression:
            print("::error title=DRAFT_FAST_ONLY::Quick checks are not a merge approval. "
                  "After quick checks pass, mark this PR ready for review to run the "
                  "full regression. Do not rerun this draft run.")
            return 1
        return 0
    paths = None
    if args.kind == "backend" and event == "pull_request" and not draft:
        paths = git_changed_paths(
            os.environ.get("CI_BASE_SHA", ""), os.environ.get("CI_HEAD_SHA", ""))
    publish(make_plan(args.kind, event, draft, paths))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
