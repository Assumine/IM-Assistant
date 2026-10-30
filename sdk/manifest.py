"""Bounded, static, fail-closed package and public object validation.

Discovery never imports package code, invokes its entry point, or fetches a URL.
"""

import base64
import binascii
import json
import re
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from pathlib import Path, PureWindowsPath
from types import MappingProxyType

from jsonschema import Draft202012Validator, FormatChecker

from .contracts import BackendDescriptor, MAX_FRAME_BYTES, MAX_RESOURCE_CHUNK_BYTES
from .errors import ContractError

SCHEMA_ROOT = Path(__file__).resolve().parents[1] / "docs/architecture/contracts"
MAX_STATIC_BYTES = 256 * 1024
FORMATS = FormatChecker()


@FORMATS.checks("date-time", raises=(ValueError, TypeError))
def _date_time(value):
    # jsonschema's optional RFC3339 dependency is deliberately not required.
    # Install-independent validation prevents invalid watermarks/expiry strings.
    if not isinstance(value, str):
        return True
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:[0-5]\d(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)", value):
        return False
    return datetime.fromisoformat(value.upper().replace("Z", "+00:00")).tzinfo is not None


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ContractError("Duplicate JSON object field")
        result[key] = value
    return result


def decode_json(data: bytes):
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=_pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (UnicodeError, ValueError, RecursionError) as error:
        raise ContractError("Invalid UTF-8 JSON") from error


def bounded_json(value, *, limit=MAX_FRAME_BYTES):
    def visit(item, depth=0):
        if depth > 64:
            raise ContractError("JSON nesting exceeds limit")
        if type(item) is dict:
            if any(type(k) is not str for k in item):
                raise ContractError("JSON object keys must be strings")
            for child in item.values():
                visit(child, depth + 1)
        elif type(item) is list:
            for child in item:
                visit(child, depth + 1)
        elif item is not None and type(item) not in (str, int, float, bool):
            raise ContractError("Value is not JSON data")
    visit(value)
    try:
        data = json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (ValueError, UnicodeError, OverflowError) as error:
        raise ContractError("Value is not finite UTF-8 JSON") from error
    if len(data) > limit:
        raise ContractError("JSON data exceeds byte limit")
    return data


@lru_cache(maxsize=3)
def _schema(kind):
    return decode_json((SCHEMA_ROOT / (kind + ".schema.json")).read_bytes())


def _validate(schema, value):
    bounded_json(value)
    # No untrusted schema/reference resolver is involved here.
    validator = Draft202012Validator(schema, format_checker=FORMATS)
    error = next(validator.iter_errors(value), None)
    if error:
        # jsonschema messages include actual values; expose only the field path.
        path = "/".join(str(p) for p in error.absolute_path)[:160]
        raise ContractError("Invalid contract field: " + (path or "root"))


def validate_descriptor(value: dict) -> BackendDescriptor:
    _validate(_schema("backend-descriptor"), value)
    return BackendDescriptor(value["backend_id"], value["backend_version"],
                             frozenset(value["methods"]),
                             MappingProxyType(dict(value["capabilities"])))


def validate_message(value: dict):
    schema = _schema("backend-event")
    _validate({"$ref": "#/$defs/message", "$defs": schema["$defs"]}, value)


def validate_event(value: dict):
    _validate(_schema("backend-event"), value)
    ref = value["conversation_ref"]
    if ref and ref["backend_instance_id"] != value["backend_instance_id"]:
        raise ContractError("Event and conversation instance differ")
    message = value["payload"].get("message") if value["type"].startswith("message.") else None
    if message:
        for key in ("request_id", "native_input_id", "native_run_id"):
            if message[key] != value[key]:
                raise ContractError("Message and event ownership differ")
        resources = list(message.get("attachments", []))
        if "resource_ref" in message:
            resources.append(message["resource_ref"])
        for resource in resources:
            if (resource["backend_instance_id"] != ref["backend_instance_id"] or
                    resource["conversation_id"] != ref["conversation_id"]):
                raise ContractError("Resource and conversation scope differ")


def validate_resource_read(value: dict):
    schema = _schema("backend-event")
    _validate({"$ref": "#/$defs/resource_read", "$defs": schema["$defs"]}, value)
    ref, resource = value["conversation_ref"], value["resource_ref"]
    if (resource["backend_instance_id"] != ref["backend_instance_id"] or
            resource["conversation_id"] != ref["conversation_id"]):
        raise ContractError("Resource request crosses scope")
    if value["offset"] > resource["size_bytes"]:
        raise ContractError("Resource offset exceeds size")


def validate_resource_chunk(value: dict, request: dict | None = None):
    schema = _schema("backend-event")
    _validate({"$ref": "#/$defs/resource_chunk", "$defs": schema["$defs"]}, value)
    try:
        data = base64.b64decode(value["data_base64"], validate=True)
    except (ValueError, binascii.Error) as error:
        raise ContractError("Invalid resource base64") from error
    end = value["offset"] + len(data)
    size = value["resource_ref"]["size_bytes"]
    if len(data) > MAX_RESOURCE_CHUNK_BYTES or end > size or value["eof"] != (end == size):
        raise ContractError("Resource chunk range or EOF is inconsistent")
    if not data and not value["eof"]:
        raise ContractError("Empty nonterminal resource chunk")
    if request is not None:
        validate_resource_read(request)
        if (value["resource_ref"] != request["resource_ref"] or value["offset"] != request["offset"] or
                len(data) > request["limit"]):
            raise ContractError("Resource chunk does not match requested reference or range")


def package_file(root: Path, relative: str) -> Path:
    # Reject Windows and POSIX escape syntax on either host platform.
    if (not relative or "\\" in relative or ":" in relative or
            Path(relative).is_absolute() or PureWindowsPath(relative).drive or
            any(part in ("", ".", "..") for part in relative.split("/"))):
        raise ContractError("Package path must be a contained relative file")
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ContractError("Package file is missing or escapes its root")
    return path


def _read_static(path: Path):
    with path.open("rb") as handle:
        data = handle.read(MAX_STATIC_BYTES + 1)
    if len(data) > MAX_STATIC_BYTES:
        raise ContractError("Static JSON exceeds byte limit")
    return decode_json(data)


def _check_config_schema(schema):
    if type(schema) is not dict:
        raise ContractError("Configuration schema must be an object")
    def visit(value):
        if type(value) is dict:
            for key, child in value.items():
                if key in ("$ref", "$dynamicRef") and (not isinstance(child, str) or not child.startswith("#")):
                    raise ContractError("Configuration schema cannot fetch external references")
                visit(child)
        elif type(value) is list:
            for child in value:
                visit(child)
    bounded_json(schema, limit=MAX_STATIC_BYTES)
    visit(schema)
    try:
        Draft202012Validator.check_schema(schema)
    except Exception as error:
        raise ContractError("Invalid configuration schema") from error


@dataclass(frozen=True)
class Package:
    root: Path
    manifest: dict
    descriptor: BackendDescriptor | None


def load_package(root: Path) -> Package:
    root = Path(root).resolve()
    manifest = _read_static(package_file(root, "module.json"))
    _validate(_schema("module-manifest"), manifest)
    runtime = manifest["runtime"]
    if runtime["mode"] == "managed_process":
        command = runtime["command"]
        # Runtime tokens resolve through the future host runtime catalog only.
        if command[0] not in ("${runtime:python}", "${runtime:node}"):
            package_file(root, command[0])
        for arg in command[1:]:
            if arg.startswith("${"):
                raise ContractError("Runtime tokens are allowed only as the executable")
        if command[0].startswith("${runtime:"):
            if len(command) < 2:
                raise ContractError("Managed interpreter requires a package entry file")
            package_file(root, command[1])
    else:
        from urllib.parse import urlsplit
        try:
            port = urlsplit(runtime["endpoint"]).port
        except ValueError as error:
            raise ContractError("Invalid loopback port") from error
        if port is None or not 1 <= port <= 65535:
            raise ContractError("Invalid loopback port")
    descriptor = None
    if "backend_descriptor" in manifest:
        descriptor = validate_descriptor(_read_static(package_file(root, manifest["backend_descriptor"])))
        if descriptor.backend_id != manifest["id"] or descriptor.backend_version != manifest["version"]:
            raise ContractError("Package and backend identity or version differ")
    if "config_schema" in manifest:
        _check_config_schema(_read_static(package_file(root, manifest["config_schema"])))
    return Package(root, manifest, descriptor)
