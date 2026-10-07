import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("ci-plan.py")
spec = importlib.util.spec_from_file_location("ci_plan", SCRIPT)
ci = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = ci
spec.loader.exec_module(ci)

class ModeTests(unittest.TestCase):
    def test_drafts_never_claim_full_or_pg18(self):
        for kind in ("backend", "web"):
            with self.subTest(kind=kind):
                p = ci.make_plan(kind, "pull_request", True, [".github/workflows/ci.yml"])
                self.assertFalse(p.full_regression)
                self.assertFalse(p.pg18_required)

    def test_ready_prs_always_keep_full_main_regression(self):
        for kind in ("backend", "web"):
            for paths in (None, [], ["docs/readme.md"], ["src/new.ts"]):
                with self.subTest(kind=kind, paths=paths):
                    self.assertTrue(ci.make_plan(kind, "pull_request", False, paths).full_regression)

    def test_main_is_full_even_without_pr_payload(self):
        for kind in ("backend", "web"):
            p = ci.make_plan(kind, "push", False, ["docs/readme.md"])
            self.assertTrue(p.full_regression)
            self.assertEqual(p.pg18_required, kind == "backend")
        self.assertTrue(ci.make_plan("backend", "push", True).full_regression)

    def test_invalid_metadata_cannot_publish_a_plan(self):
        for event in ("", "pull_request_target", "workflow_run"):
            with self.assertRaises(ValueError):
                ci.make_plan("backend", event, False)
        with self.assertRaises(ValueError):
            ci.make_plan("backend", "pull_request", "false")
        with self.assertRaises(ValueError):
            ci.make_plan("other", "push", False)

class ScopeTests(unittest.TestCase):
    def test_protected_paths_override_otherwise_unrelated_roots(self):
        paths = [
            "ops/dou-clean-02/runner/postdeploy-smoke.sh",
            "ops/dou-clean-02/runner/tests/fixture.sql",
            "src/modules/publication-scope/publication-scope.guard.ts",
            "src/modules/collection/dou-historical-cleanup.executor.ts",
            "src/infrastructure/database/provision-runtime-role.ts",
            "src/modules/auth/auth.service.ts",
            "src/new-role.SQL", "test/fixture.sql", "docs/example.sql",
            "docs/publication-scope-notes.md", "test/RLS-new.test.ts",
            "migrations/999_anything.sql", ".github/scripts/ci-plan.py",
            ".github/workflows/ci.yml", "package.json", "package-lock.json",
            ".npmrc", ".nvmrc", "tsconfig.new.json", "Dockerfile", "ops/new/Dockerfile",
        ]
        for path in paths:
            with self.subTest(path=path):
                self.assertTrue(ci.make_plan("backend", "pull_request", False, [path]).pg18_required)

    def test_proven_unrelated_paths_only_skip_specialized_gate(self):
        p = ci.make_plan("backend", "pull_request", False, [
            "src/modules/taxonomy/taxonomy.service.ts",
            "test/archive-date-filter.integration.test.ts",
            "src/modules/ncm/ncm.ts", "docs/ncm.md", "README.md"])
        self.assertTrue(p.full_regression)
        self.assertFalse(p.pg18_required)

    def test_unknown_or_bad_paths_are_conservative(self):
        for path in ("ops/new-tool/run.sh", "scripts/unknown.py", "new-root/data.txt",
                     "", "/src/a.ts", "../src/a.ts", "src/../a.ts", "src//a.ts",
                     "src/./a.ts", "src\\a.ts", None):
            with self.subTest(path=path):
                self.assertTrue(ci.make_plan("backend", "pull_request", False, [path]).pg18_required)
        for paths in (None, []):
            self.assertTrue(ci.make_plan("backend", "pull_request", False, paths).pg18_required)

    def test_mixed_diff_never_loses_protected_path(self):
        self.assertTrue(ci.make_plan("backend", "pull_request", False,
                                    ["src/taxonomy.ts", "docs/x.sql"]).pg18_required)

class DiffTests(unittest.TestCase):
    def test_nul_handles_unicode_newlines_and_deletions(self):
        data = "src/tributação\nfile.ts\0ops/dou-clean-02/removed.sh\0".encode()
        paths = ci.parse_nul_diff(data)
        self.assertEqual(len(paths), 2)
        self.assertTrue(ci.make_plan("backend", "pull_request", False, paths).pg18_required)

    def test_empty_truncated_or_malformed_diff_stays_unproven(self):
        for data in (b"", b"src/a.ts", b"\0", b"src/a.ts\0\0", b"src/\xff.ts\0"):
            self.assertIsNone(ci.parse_nul_diff(data))

    def test_fetch_failure_timeout_and_invalid_shas_do_not_skip_pg18(self):
        sha = "a" * 40
        for failure in (subprocess.CalledProcessError(1, "git"),
                        subprocess.TimeoutExpired("git", 45), OSError("missing")):
            with patch.object(ci.subprocess, "run", side_effect=failure):
                paths = ci.git_changed_paths(sha, sha)
            self.assertTrue(ci.make_plan("backend", "pull_request", False, paths).pg18_required)
        with patch.object(ci.subprocess, "run") as run:
            self.assertIsNone(ci.git_changed_paths("--help", sha))
            run.assert_not_called()

    def test_git_diff_keeps_both_paths_of_real_rename(self):
        # Real local git diff verifies protected deletion cannot hide in a rename.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.check_output(["git", "-C", directory, *args])
            git("init", "-q")
            git("config", "user.name", "CI fixture")
            git("config", "user.email", "fixture@example.invalid")
            protected = root / "ops/dou-clean-02/removed.sh"
            protected.parent.mkdir(parents=True)
            protected.write_text("fixture", encoding="utf-8")
            git("add", "."); git("commit", "-qm", "before")
            base = git("rev-parse", "HEAD").decode().strip()
            (root / "src").mkdir()
            protected.rename(root / "src/renamed.ts")
            git("add", "-A"); git("commit", "-qm", "after")
            head = git("rev-parse", "HEAD").decode().strip()
            paths = ci.parse_nul_diff(git("diff", "--no-renames", "--name-only", "-z", base, head))
            self.assertIn("ops/dou-clean-02/removed.sh", paths)
            self.assertIn("src/renamed.ts", paths)
            self.assertTrue(ci.make_plan("backend", "pull_request", False, paths).pg18_required)

class CliTests(unittest.TestCase):
    def cli(self, *args, **values):
        env = os.environ.copy()
        for key in ("GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY", "CI_BASE_SHA", "CI_HEAD_SHA"):
            env.pop(key, None)
        env.update(CI_EVENT_NAME="pull_request", CI_DRAFT="false")
        env.update(values)
        return subprocess.run([sys.executable, str(SCRIPT), "--kind", "backend", *args],
                              env=env, text=True, capture_output=True)

    def test_draft_fence_is_nonzero_and_explains_next_action(self):
        p = self.cli("--require-full", CI_DRAFT="true")
        self.assertEqual(p.returncode, 1)
        self.assertIn("DRAFT_FAST_ONLY", p.stdout)
        self.assertIn("ready for review", p.stdout)
        self.assertIn("Do not rerun", p.stdout)

    def test_ready_and_main_fence_pass(self):
        self.assertEqual(self.cli("--require-full").returncode, 0)
        self.assertEqual(self.cli("--require-full", CI_EVENT_NAME="push").returncode, 0)

    def test_missing_invalid_metadata_is_not_a_green_fence(self):
        self.assertNotEqual(self.cli("--require-full", CI_DRAFT="").returncode, 0)
        self.assertNotEqual(self.cli("--require-full", CI_EVENT_NAME="").returncode, 0)

    def test_unproven_diff_publishes_true_and_github_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output"
            summary = Path(directory) / "summary"
            result = self.cli(GITHUB_OUTPUT=str(output), GITHUB_STEP_SUMMARY=str(summary))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(json.loads(result.stdout)["pg18_required"])
            self.assertIn("pg18_required=true", output.read_text())
            self.assertIn("full_regression=true", output.read_text())
            self.assertIn("diff-unproven", summary.read_text())

if __name__ == "__main__":
    unittest.main()
