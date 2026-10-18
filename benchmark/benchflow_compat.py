"""Narrow Windows path fix for the pinned BenchFlow 0.6.3 container helpers.

Only functions which use Path for POSIX sandbox path manipulation are rebound.
No installed files, task files, execution policies or verifier logic are changed.
"""

import importlib.metadata
import os
import posixpath
from pathlib import PurePosixPath
from types import FunctionType, SimpleNamespace


def posix_function(function, **extra):
    replacement = FunctionType(
        function.__code__,
        {**function.__globals__, "Path": PurePosixPath, **extra},
        function.__name__,
        function.__defaults__,
        function.__closure__,
    )
    replacement.__kwdefaults__ = function.__kwdefaults__
    return replacement


def apply_windows_path_compat():
    if os.name != "nt":
        return
    assert importlib.metadata.version("benchflow") == "0.6.3"
    import benchflow.agents.install as install
    import benchflow.sandbox.lockdown as lockdown
    import benchflow.sandbox.setup as setup
    import benchflow.rollout_planes as planes

    for name in ("_skill_link_cmd", "_owner_from_home", "_link_skill_paths"):
        setattr(install, name, posix_function(getattr(install, name)))
    lockdown._legacy_root_tool_link_cmd = posix_function(
        lockdown._legacy_root_tool_link_cmd
    )
    lockdown._validate_locked_path = posix_function(
        lockdown._validate_locked_path, os=SimpleNamespace(path=posixpath)
    )
    setup._inject_skills_into_dockerfile = posix_function(
        setup._inject_skills_into_dockerfile
    )
    planes._inject_skills_into_dockerfile = setup._inject_skills_into_dockerfile
    planes._link_skill_paths = install._link_skill_paths
