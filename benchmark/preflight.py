"""Validate every official task with the pinned parser and registry digest. No Docker/model calls."""

import importlib.metadata
import json
import sys
from pathlib import Path

from benchflow._utils.task_authoring import task_digest
from benchflow.task.document import TaskDocument


def audit(data):
    assert importlib.metadata.version("benchflow") == "0.6.3"
    base = Path(data) / "skillsbench"
    sources = json.loads(
        (Path(__file__).parent / "sources.json").read_text(encoding="utf-8")
    )
    blocked = json.loads(
        (Path(__file__).parent / "blocked-inputs.json").read_text(encoding="utf-8")
    )
    registry = json.loads((base / "registry.json").read_text(encoding="utf-8"))
    suite = next(
        entry
        for entry in registry
        if entry["name"] == "skillsbench" and entry["version"] == "1.1"
    )
    assert len(suite["tasks"]) == sources["skillsbench"]["tasks"]
    tasks = []
    blocked_tasks = []
    for spec in suite["tasks"]:
        assert spec["git_commit_id"] == sources["skillsbench"]["revision"], (
            "Registry/task revision mismatch"
        )
        task = base / spec["path"]
        assert task.resolve().is_relative_to(base.resolve())
        if spec["name"] in blocked:
            blocked_tasks.append({"name": spec["name"], **blocked[spec["name"]]})
            continue
        assert task_digest(task) == spec["digest"], (
            f"Task digest mismatch: {spec['name']}"
        )
        document = TaskDocument.from_path(task / "task.md")
        assert document.instruction.strip(), f"Empty instruction: {spec['name']}"
        tasks.append(
            {
                "name": spec["name"],
                "digest": spec["digest"],
                "registeredCommit": spec["git_commit_id"],
                "skills": len(list((task / "environment/skills").rglob("SKILL.md"))),
            }
        )
    return {
        "benchflowVersion": "0.6.3",
        "tasks": tasks,
        "count": len(tasks),
        "expected": len(suite["tasks"]),
        "blockedTasks": blocked_tasks,
        "ready": not blocked_tasks,
    }


if __name__ == "__main__":
    try:
        print(json.dumps(audit(sys.argv[1])))
    except Exception as error:
        print(
            json.dumps(
                {
                    "error": "preflight_failed",
                    "errorType": type(error).__name__,
                    "detail": str(error)[:200],
                }
            )
        )
        sys.exit(1)
