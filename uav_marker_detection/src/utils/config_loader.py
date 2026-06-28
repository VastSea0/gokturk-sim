from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Union

import yaml


def deep_merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    result = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def load_yaml(path: Union[str, Path]) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as handle:
        return yaml.safe_load(handle) or {}


def load_config(config_path: Union[str, Path]) -> Dict[str, Any]:
    config_path = Path(config_path)
    default_path = config_path.parent / "default.yaml"
    config: Dict[str, Any] = {}
    if default_path.exists() and default_path != config_path:
        config = load_yaml(default_path)
    current = load_yaml(config_path)
    return deep_merge(config, current)


def get_nested(config: Dict[str, Any], dotted_path: str, default: Any = None) -> Any:
    node: Any = config
    for part in dotted_path.split("."):
        if not isinstance(node, dict) or part not in node:
            return default
        node = node[part]
    return node
