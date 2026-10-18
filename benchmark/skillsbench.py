"""Pinned BenchFlow 0.6.3 lifecycle with a host Pi worker; never pass keys to the sandbox."""

import argparse
import asyncio
import contextlib
import importlib.metadata
import json
import math
import os
import shutil
import sys
from pathlib import Path


async def verify_trial(rollout, message):
    """Verifier exceptions must retain the already-observed model usage."""
    try:
        rewards = await rollout.verify()
        error = rollout._verifier_error
    except Exception:
        rewards, error = None, True
    row = message["row"]
    reward = rewards.get("reward") if isinstance(rewards, dict) else None
    if (
        error
        or not isinstance(reward, (int, float))
        or not math.isfinite(reward)
        or not 0 <= reward <= 1
    ):
        row["taskSuccess"] = None
        row["verifierStatus"] = "error"
    else:
        row["taskSuccess"] = reward == 1
        row["verifierStatus"] = "passed" if reward == 1 else "failed"
    return message


async def run(config):
    worker_env = dict(os.environ)
    for key in ("LLM_API_KEY", "LLM_BASE_URL", "TYPESAFE_API_KEY", "TYPESAFE_BASE_URL"):
        os.environ.pop(
            key, None
        )  # BenchFlow/verifier expansion cannot expose worker credentials.
    assert importlib.metadata.version("benchflow") == "0.6.3", (
        "BenchFlow version mismatch"
    )
    from benchflow import Rollout, RolloutConfig, Scene
    from benchflow.agents.registry import register_agent
    from benchflow._utils.task_authoring import task_digest
    from benchflow_compat import apply_windows_path_compat

    apply_windows_path_compat()

    task = Path(config["task"]).resolve()
    blocked = json.loads(
        (Path(__file__).parent / "blocked-inputs.json").read_text(encoding="utf-8")
    )
    if task.name in blocked:
        raise RuntimeError(
            "Task blocked by security software; do not restore or execute"
        )
    output = Path(config["output"]).resolve()
    output.mkdir(parents=True, exist_ok=True)
    register_agent(
        name="jev-benchmark-host",
        install_cmd="true",
        launch_cmd="true",
        requires_env=[],
        skill_paths=[],
    )
    rollout = await Rollout.create(
        RolloutConfig(
            task_path=task,
            scenes=[
                Scene.single(
                    agent="oracle" if config.get("oracle") else "jev-benchmark-host"
                )
            ],
            environment="docker",
            sandbox_user="agent",
            skip_agent_install=not config.get("oracle", False),
            skill_mode="with-skill",
            jobs_dir=output / "benchflow",
            timeout=math.ceil(config["limits"]["taskTimeoutMs"] / 1000),
            dataset={"name": "skillsbench", "version": "1.1"},
            task_digest=task_digest(task),
        )
    )
    if config.get("oracle"):
        result = await rollout.run()
        return {
            "oracle": True,
            "result": result.to_dict() if hasattr(result, "to_dict") else str(result),
        }
    worker = None
    message = None
    try:
        await rollout.setup()
        await rollout.start()
        await rollout.install_agent()
        assert rollout._env is not None
        prompts = rollout._resolved_prompts
        if len(prompts) != 1:
            raise ValueError(
                "Unsupported task prompt plan; do not silently omit scenes"
            )
        virtual = output / "virtual-root"
        skill_host = rollout._effective_skills_dir
        skill_remote = rollout._effective_skills_sandbox_dir or "/skills"
        mirrored = virtual / skill_remote.lstrip("/")
        if skill_host:
            shutil.copytree(skill_host, mirrored, dirs_exist_ok=True)
        else:
            mirrored.mkdir(parents=True, exist_ok=True)
        gold = sorted(
            p.relative_to(mirrored).as_posix() for p in mirrored.rglob("SKILL.md")
        )
        init = dict(
            virtualRoot=str(virtual),
            cwd=rollout._agent_cwd,
            skills=skill_remote,
            taskId=task.name,
            group=config["group"],
            prompt=prompts[0],
            output=str(output),
            limits=config["limits"],
            model=config["model"],
            gold=gold,
            evidence=config.get("evidence", "live"),
            nativeOAuth=config.get("nativeOAuth", False),
        )
        worker = await asyncio.create_subprocess_exec(
            config["node"],
            "--import",
            "tsx",
            "benchmark/task-worker.ts",
            cwd=config["project"],
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=64 * 1024 * 1024,
            env=worker_env,
        )
        worker.stdin.write((json.dumps(init) + "\n").encode())
        await worker.stdin.drain()

        async def communicate():
            trace = output / "bridge.jsonl"
            count = 0
            while True:
                line = await worker.stdout.readline()
                if not line:
                    raise RuntimeError("Worker closed without evidence")
                message = json.loads(line)
                if message["type"] == "result":
                    return message
                if message["type"] == "error":
                    raise RuntimeError("Worker failed")
                assert message["type"] == "exec"
                count += 1
                # Trace metadata only; model commands/output are not needed for the accuracy metric.
                with trace.open("a", encoding="utf-8") as out:
                    out.write(
                        json.dumps(
                            {
                                "sequence": count,
                                "id": message["id"],
                                "cwd": message.get("cwd"),
                            }
                        )
                        + "\n"
                    )
                response = {"id": message["id"]}
                try:
                    result = await rollout._env.exec(
                        message["command"],
                        cwd=message.get("cwd") or rollout._agent_cwd,
                        timeout_sec=min(
                            math.ceil(message.get("timeout") or 120),
                            math.ceil(config["limits"]["taskTimeoutMs"] / 1000),
                        ),
                        user="agent",
                        env={"HOME": "/home/agent"},
                        service="main",
                    )
                    response["result"] = {
                        "stdout": result.stdout,
                        "stderr": result.stderr,
                        "return_code": result.return_code,
                    }
                except Exception:
                    response["error"] = "sandbox_exec_failed"
                worker.stdin.write((json.dumps(response) + "\n").encode())
                await worker.stdin.drain()

        # Drain stderr concurrently so a filled pipe cannot deadlock the worker.
        stderr_task = asyncio.create_task(worker.stderr.read())
        message = await asyncio.wait_for(
            communicate(), config["limits"]["taskTimeoutMs"] / 1000 + 30
        )
        worker.stdin.close()
        await asyncio.wait_for(worker.wait(), 10)
        await stderr_task
        return await verify_trial(rollout, message)
    finally:
        if worker and worker.returncode is None:
            worker.kill()
            await worker.wait()
        try:
            await rollout.cleanup()
        except Exception:
            if message is None:
                raise
            message["stopped"] = "cleanup_failed"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        # BenchFlow is allowed to log setup/build output; keep protocol stdout machine-readable.
        with contextlib.redirect_stdout(sys.stderr):
            result = asyncio.run(run(config))
        print(json.dumps(result), flush=True)
    except Exception as error:
        if "config" in locals() and config.get("evidence") == "mock":
            import traceback

            traceback.print_exc(file=sys.stderr)
        partial = (
            Path(config["output"]) / "partial.json" if "config" in locals() else None
        )
        if partial and partial.exists():
            row = json.loads(partial.read_text(encoding="utf-8"))
            row.update(status="harness_error", verifierStatus="error", taskSuccess=None)
            print(
                json.dumps({"type": "result", "row": row, "stopped": "backend_error"}),
                flush=True,
            )
            return
        print(
            json.dumps(
                {
                    "type": "error",
                    "code": "skillsbench_backend_failed",
                    "errorType": type(error).__name__,
                }
            ),
            flush=True,
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
