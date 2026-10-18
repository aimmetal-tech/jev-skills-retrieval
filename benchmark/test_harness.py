"""No-network regression tests for quarantine handling and Windows path protection."""

import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import tarfile

import prepare
from benchflow_compat import apply_windows_path_compat
from skillsbench import verify_trial


class PreparationTests(unittest.TestCase):
    def make_archive(self, data, escape=False):
        with tarfile.open(data / "skillsbench.tar.gz", "w:gz") as archive:
            files = {
                "tasks/fix-druid-loophole-cve/task.md": "fixture",
                "tasks/fix-druid-loophole-cve/environment/Dockerfile": "FROM scratch",
                "tasks/fix-druid-loophole-cve/oracle/solve.sh": "true",
                "tasks/fix-druid-loophole-cve/verifier/test.sh": "true",
                # Inert sentinel only; never the actual quarantined source.
                "tasks/fix-druid-loophole-cve/verifier/test_outputs.py": "QUARANTINE_SENTINEL",
            }
            if escape:
                files = {"tasks/../../../escaped.txt": "do not write"}
            for name, text in files.items():
                info = tarfile.TarInfo("fixture/" + name)
                payload = text.encode()
                info.size = len(payload)
                archive.addfile(info, io.BytesIO(payload))

    def test_preparation_never_restores_quarantined_input(self):
        with tempfile.TemporaryDirectory(prefix="jev-prepare-test-") as directory:
            data = Path(directory)
            self.make_archive(data)
            spec = {"skillsbench": {**prepare.SOURCES["skillsbench"], "tasks": 1}}
            with (
                patch.object(prepare, "SOURCES", spec),
                patch("urllib.request.urlopen", return_value=io.BytesIO(b"[]")),
            ):
                audit = prepare.prepare_skillsbench(data, offline=False)
            self.assertFalse(
                (
                    data
                    / "skillsbench/tasks/fix-druid-loophole-cve/verifier/test_outputs.py"
                ).exists()
            )
            self.assertIn("fix-druid-loophole-cve", audit["blockedTasks"])
            self.assertEqual(len(audit["tasks"]), 1)

    def test_archive_path_escape_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="jev-prepare-test-") as directory:
            data = Path(directory)
            self.make_archive(data, escape=True)
            with self.assertRaisesRegex(AssertionError, "Archive path escape"):
                prepare.prepare_skillsbench(data, offline=False)

    def test_blocked_list_is_machine_readable_and_preserves_original_roster(self):
        policy = json.loads(
            (Path(__file__).parent / "blocked-inputs.json").read_text(encoding="utf-8")
        )
        self.assertEqual(prepare.SOURCES["skillsbench"]["tasks"], 87)
        self.assertEqual(
            policy["fix-druid-loophole-cve"]["files"], ["verifier/test_outputs.py"]
        )


class SandboxCompatibilityTests(unittest.TestCase):
    def test_posix_path_fix_keeps_lockdown_traversal_checks(self):
        apply_windows_path_compat()
        from benchflow.sandbox.lockdown import _validate_locked_path
        from benchflow.agents.install import _skill_link_cmd

        _validate_locked_path("/oracle")
        for path in ("/oracle/../logs", "/oracle;whoami", "relative", "/oracle/"):
            with self.assertRaises(ValueError):
                _validate_locked_path(path)
        command = _skill_link_cmd(
            "/skills", "/home/agent/.pi/agent/skills", "agent", []
        )
        self.assertIn("mkdir -p /home/agent/.pi/agent", command)
        self.assertNotIn("\\", command)


class VerifierEvidenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_valid_partial_reward_is_a_task_failure_not_a_verifier_error(self):
        class PartialVerifier:
            _verifier_error = None

            async def verify(self):
                return {"reward": 0.5}

        result = await verify_trial(PartialVerifier(), {"row": {}})
        self.assertFalse(result["row"]["taskSuccess"])
        self.assertEqual(result["row"]["verifierStatus"], "failed")

    async def test_verifier_exception_retains_paid_usage_and_is_not_a_normal_failure(
        self,
    ):
        class BrokenVerifier:
            async def verify(self):
                raise RuntimeError("fixture verifier crashed")

        message = {
            "row": {
                "pi": {"total": 123},
                "requests": {"pi": 2},
                "verifierStatus": "pending",
            }
        }
        result = await verify_trial(BrokenVerifier(), message)
        self.assertEqual(result["row"]["pi"]["total"], 123)
        self.assertEqual(result["row"]["requests"]["pi"], 2)
        self.assertIsNone(result["row"]["taskSuccess"])
        self.assertEqual(result["row"]["verifierStatus"], "error")


if __name__ == "__main__":
    unittest.main()
