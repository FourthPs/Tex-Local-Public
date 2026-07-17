"""Persistent per-project locations and one-time desktop folder selections.

The default TexLocal ``projects`` directory remains implicit.  This store only
records projects deliberately created under another parent directory, keeping
the common path unchanged while allowing individual projects to live elsewhere.
"""

from __future__ import annotations

import json
import os
import secrets
import tempfile
import threading
import time


_REGISTRY_VERSION = 1


def default_registry_path(environ=None) -> str:
    env = os.environ if environ is None else environ
    explicit = str(env.get("TEXLOCAL_PROJECT_REGISTRY", "")).strip()
    if explicit:
        return os.path.abspath(os.path.expanduser(explicit))
    base = (env.get("LOCALAPPDATA") or env.get("APPDATA")
            or os.path.expanduser("~"))
    return os.path.join(base, "TexLocal", "project-locations.json")


def _normal_project_path(name: str, path: str) -> str:
    if not isinstance(name, str) or not name:
        raise ValueError("Invalid project name")
    if not isinstance(path, str) or not path.strip():
        raise ValueError("Invalid project location")
    normalized = os.path.realpath(os.path.abspath(os.path.expanduser(path)))
    parent = os.path.dirname(normalized)
    if parent == normalized:
        raise ValueError("A filesystem root cannot be a project")
    actual_name = os.path.basename(normalized.rstrip(os.sep))
    if os.path.normcase(actual_name) != os.path.normcase(name):
        raise ValueError("Project location must end with the project name")
    return normalized


class ProjectLocationStore:
    """Small atomic JSON registry for non-default project paths."""

    def __init__(self, path: str):
        self.path = os.path.abspath(path)
        self._lock = threading.RLock()
        self._loaded = False
        self._projects: dict[str, str] = {}

    def _load_locked(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                raw = json.load(handle)
        except (OSError, ValueError, TypeError):
            return
        entries = raw.get("projects", {}) if isinstance(raw, dict) else {}
        if not isinstance(entries, dict):
            return
        for name, entry in entries.items():
            path = entry.get("path") if isinstance(entry, dict) else entry
            try:
                self._projects[name] = _normal_project_path(name, path)
            except (TypeError, ValueError):
                continue

    def _matching_key_locked(self, name: str) -> str | None:
        wanted = os.path.normcase(name)
        for existing in self._projects:
            if os.path.normcase(existing) == wanted:
                return existing
        return None

    def _write_locked(self) -> None:
        directory = os.path.dirname(self.path)
        os.makedirs(directory, exist_ok=True)
        payload = {
            "version": _REGISTRY_VERSION,
            "projects": {
                name: {"path": path}
                for name, path in sorted(self._projects.items(), key=lambda item: item[0].lower())
            },
        }
        fd, temp_path = tempfile.mkstemp(
            prefix="project-locations-", suffix=".tmp", dir=directory
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_path, self.path)
        finally:
            try:
                os.unlink(temp_path)
            except FileNotFoundError:
                pass

    def all(self) -> dict[str, str]:
        with self._lock:
            self._load_locked()
            return dict(self._projects)

    def get(self, name: str) -> str | None:
        with self._lock:
            self._load_locked()
            key = self._matching_key_locked(name)
            return self._projects.get(key) if key is not None else None

    def contains(self, name: str) -> bool:
        return self.get(name) is not None

    def register(self, name: str, path: str) -> str:
        normalized = _normal_project_path(name, path)
        with self._lock:
            self._load_locked()
            key = self._matching_key_locked(name)
            if key is not None and key != name:
                raise ValueError("Project name is already registered")
            before = dict(self._projects)
            self._projects[name] = normalized
            try:
                self._write_locked()
            except BaseException:
                self._projects = before
                raise
        return normalized

    def unregister(self, name: str) -> None:
        with self._lock:
            self._load_locked()
            key = self._matching_key_locked(name)
            if key is None:
                return
            before = dict(self._projects)
            del self._projects[key]
            try:
                self._write_locked()
            except BaseException:
                self._projects = before
                raise

    def rename(self, old_name: str, new_name: str, new_path: str) -> str:
        normalized = _normal_project_path(new_name, new_path)
        with self._lock:
            self._load_locked()
            old_key = self._matching_key_locked(old_name)
            if old_key is None:
                raise ValueError("Project location is not registered")
            new_key = self._matching_key_locked(new_name)
            if new_key is not None and new_key != old_key:
                raise ValueError("Project name is already registered")
            before = dict(self._projects)
            del self._projects[old_key]
            self._projects[new_name] = normalized
            try:
                self._write_locked()
            except BaseException:
                self._projects = before
                raise
        return normalized


_token_lock = threading.Lock()
_location_tokens: dict[str, tuple[str, float]] = {}


def issue_project_location_token(parent: str, *, ttl_seconds: float = 600) -> tuple[str, str]:
    normalized = os.path.realpath(os.path.abspath(os.path.expanduser(parent)))
    if not os.path.isdir(normalized):
        raise ValueError("Selected folder is unavailable")
    if not os.access(normalized, os.R_OK | os.W_OK):
        raise ValueError("Selected folder is not writable")
    token = secrets.token_urlsafe(32)
    now = time.monotonic()
    with _token_lock:
        expired = [key for key, (_, deadline) in _location_tokens.items() if deadline <= now]
        for key in expired:
            del _location_tokens[key]
        _location_tokens[token] = (normalized, now + max(1, ttl_seconds))
    return token, normalized


def consume_project_location_token(token: str) -> str | None:
    if not isinstance(token, str) or not token:
        return None
    now = time.monotonic()
    with _token_lock:
        entry = _location_tokens.pop(token, None)
    if entry is None:
        return None
    parent, deadline = entry
    return parent if deadline > now else None
