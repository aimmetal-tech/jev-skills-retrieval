"""Fetch pinned public TEST data only. Never imports a model client or reads LLM keys."""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES = json.loads((ROOT / "benchmark/sources.json").read_text(encoding="utf-8"))
BLOCKED = json.loads(
    (ROOT / "benchmark/blocked-inputs.json").read_text(encoding="utf-8")
)
DEFAULT_DATA = ROOT / "outputs/benchmark/data"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def rows(path):
    with path.open(encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temp.replace(path)


def prepare_skillret(data, offline):
    base = data / "skillret"
    files = [
        "README.md",
        "data/skills/test.jsonl",
        "data/queries/test.jsonl",
        "data/qrels/test.jsonl",
    ]
    if not offline:
        # The current interpreter's Hub CLI, with all caches kept inside outputs/.
        env = dict(
            os.environ,
            HF_HOME=str(data.parent / "cache/huggingface"),
            HF_HUB_DISABLE_IMPLICIT_TOKEN="1",
        )
        subprocess.run(
            [
                "hf",
                "download",
                SOURCES["skillret"]["repository"],
                *files,
                "--repo-type",
                "dataset",
                "--revision",
                SOURCES["skillret"]["revision"],
                "--local-dir",
                str(base),
                "--max-workers",
                "3",
                "--quiet",
            ],
            check=True,
            env=env,
        )
    skills = rows(base / files[1])
    queries = rows(base / files[2])
    qrels = rows(base / files[3])
    expected = SOURCES["skillret"]
    assert (len(skills), len(queries), len(qrels)) == (
        expected["skills"],
        expected["queries"],
        expected["qrels"],
    ), "Wrong dataset revision/counts"
    ids = {s["id"] for s in skills}
    assert len(ids) == len(skills), "Duplicate skill IDs"
    query_ids = {q["id"] for q in queries}
    assert len(query_ids) == len(queries), "Duplicate query IDs"
    labels = {q["id"]: set() for q in queries}
    for label in qrels:
        assert (
            label["query_id"] in query_ids
            and label["skill_id"] in ids
            and label["relevance"] == 1
        )
        labels[label["query_id"]].add(label["skill_id"])
    for query in queries:
        assert labels[query["id"]] == set(query["skill_ids"]), (
            "Incomplete or inconsistent qrels"
        )
    counts = Counter(s["name"] for s in skills)
    mapping = []
    malformed_frontmatter = 0
    generated = base / "pi-skills"
    for skill in skills:
        # Pi's native discovery deduplicates names. Only collisions receive a stable suffix.
        name = (
            skill["name"]
            if counts[skill["name"]] == 1
            else skill["name"][:24] + "--" + skill["id"].replace("-", "")
        )
        assert skill["description"].strip(), "Empty skill description"
        body = skill["skill_md"]
        frontmatter = re.match(r"\A---\r?\n.*?\r?\n---(?:\r?\n|$)", body, re.S)
        if frontmatter:
            body = body[frontmatter.end() :]
        elif body.startswith("---"):
            # Malformed upstream headers remain verbatim in the body, never discard a gold skill.
            malformed_frontmatter += 1
        path = generated / skill["id"] / "SKILL.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        text = (
            "---\nname: "
            + json.dumps(name)
            + "\ndescription: "
            + json.dumps(skill["description"], ensure_ascii=False)
            + "\n---\n"
            + body
        )
        path.write_text(text, encoding="utf-8", newline="\n")
        mapping.append(
            {
                "id": skill["id"],
                "name": name,
                "originalName": skill["name"],
                "path": path.relative_to(data).as_posix(),
                "sha256": digest(path),
            }
        )
    assert len({s["name"] for s in mapping}) == len(skills), "Name mapping collision"
    write_json(base / "mapping.json", mapping)
    return {
        "revision": expected["revision"],
        "skills": len(skills),
        "queries": len(queries),
        "qrels": len(qrels),
        "duplicateNameExcess": sum(v - 1 for v in counts.values()),
        "malformedOriginalFrontmatter": malformed_frontmatter,
        "metadataChars": sum(len(s["name"]) + len(s["description"]) for s in skills),
        "adaptations": [
            "metadata-only routing",
            "stable suffix on colliding names",
            "normalized discoverable frontmatter; original bodies retained",
            "retrieval only: scripts/resources not supplied",
        ],
        "files": {f: digest(base / f) for f in files},
        "mappingSha256": digest(base / "mapping.json"),
    }


def prepare_skillsbench(data, offline):
    spec = SOURCES["skillsbench"]
    base = data / "skillsbench"
    archive = data / "skillsbench.tar.gz"
    if not offline and not archive.exists():
        archive.parent.mkdir(parents=True, exist_ok=True)
        url = f"https://codeload.github.com/{spec['repository']}/tar.gz/{spec['revision']}"
        temp = archive.with_suffix(".partial")
        with (
            urllib.request.urlopen(url, timeout=120) as response,
            temp.open("wb") as out,
        ):
            shutil.copyfileobj(response, out)
        temp.replace(archive)
    if not offline:
        with tarfile.open(archive) as tar:
            for member in tar:
                parts = Path(member.name).parts[1:]
                if not parts or parts[0] not in (
                    "tasks",
                    "registry.json",
                    "LICENSE",
                    "README.md",
                ):
                    continue
                if parts[0] == "tasks" and len(parts) > 2 and parts[1] in BLOCKED:
                    if "/".join(parts[2:]) in BLOCKED[parts[1]]["files"]:
                        continue  # Respect the user's security software; never re-extract quarantined inputs.
                target = base.joinpath(*parts)
                assert target.resolve().is_relative_to(base.resolve()), (
                    "Archive path escape"
                )
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                elif member.isfile():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with tar.extractfile(member) as source, target.open("wb") as out:
                        shutil.copyfileobj(source, out)
                else:
                    raise ValueError(
                        "Unexpected link or special file in benchmark archive"
                    )
        # v1.1 re-pinned its registry after the task archive commit. Keep both pins.
        registry_url = f"https://raw.githubusercontent.com/{spec['repository']}/{spec['registryRevision']}/registry.json"
        with urllib.request.urlopen(registry_url, timeout=30) as response:
            (base / "registry.json").write_bytes(response.read())
    registry = json.loads((base / "registry.json").read_text(encoding="utf-8"))
    tasks = sorted(p.parent for p in (base / "tasks").glob("*/task.md"))
    assert len(tasks) == spec["tasks"], "Wrong SkillsBench task roster"
    hashes = {}
    for task in tasks:
        for required in ("environment", "oracle/solve.sh", "verifier/test.sh"):
            assert (task / required).exists(), (
                f"Missing task component: {task.name}/{required}"
            )
        for file in sorted(p for p in task.rglob("*") if p.is_file()):
            hashes[file.relative_to(base).as_posix()] = digest(file)
    return {
        "revision": spec["revision"],
        "registryRevision": spec["registryRevision"],
        "tasks": [p.name for p in tasks],
        "blockedTasks": BLOCKED,
        "registrySha256": digest(base / "registry.json"),
        "archiveSha256": digest(archive),
        "files": hashes,
        "registry": registry,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument(
        "--offline",
        action="store_true",
        help="Audit existing pinned downloads; no network",
    )
    parser.add_argument(
        "--suite", choices=("skillret", "skillsbench", "all"), default="all"
    )
    args = parser.parse_args()
    data = args.data.resolve()
    data.mkdir(parents=True, exist_ok=True)
    manifest_path = data / "manifest.json"
    manifest = (
        json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest_path.exists()
        else {"schemaVersion": 1, "sources": SOURCES}
    )
    assert manifest["sources"] == SOURCES, (
        "Existing data belongs to a different source lock"
    )
    for suite, prepare in (
        ("skillret", prepare_skillret),
        ("skillsbench", prepare_skillsbench),
    ):
        if args.suite in (suite, "all"):
            manifest[suite] = prepare(data, args.offline)
            write_json(manifest_path, manifest)
            print(f"{suite}: complete, pinned inputs audited", flush=True)


if __name__ == "__main__":
    main()
