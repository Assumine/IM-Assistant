import base64
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from sdk.contracts import CAPABILITY_METHODS, REQUIRED_METHODS
from sdk.errors import BackendError, ContractError, RetryPolicy
from sdk.manifest import (bounded_json, decode_json, load_package, package_file,
                          validate_descriptor, validate_event, validate_message,
                          validate_resource_read, validate_resource_chunk)

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "docs/architecture/examples"


def example(name):
    return json.loads((EXAMPLES / (name + ".json")).read_text(encoding="utf-8"))


def minimal_descriptor():
    value = example("native-system-backend")
    value["methods"] = sorted(REQUIRED_METHODS)
    value["capabilities"] = {k: False for k in value["capabilities"]}
    return value


class ContractTests(unittest.TestCase):
    def setUp(self):
        parent = ROOT / "runtime/tests"
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.temp.cleanup)
        self.package = Path(self.temp.name)
        self.manifest = example("module-manifest")
        self.descriptor = example("opencode-backend")
        self.manifest["runtime"]["command"] = ["${runtime:python}", "entry.py"]
        self.manifest["backend_descriptor"] = "backend.json"
        self.manifest.pop("config_schema", None)
        self.write_package()

    def write_package(self):
        (self.package / "module.json").write_text(json.dumps(self.manifest), encoding="utf-8")
        (self.package / "backend.json").write_text(json.dumps(self.descriptor), encoding="utf-8")
        (self.package / "entry.py").write_text("raise RuntimeError('MUST NOT EXECUTE')", encoding="utf-8")

    def test_discovery_is_static_even_with_unknown_contributions(self):
        self.manifest["contributions"] = {"unknown.extension": {"entry": "must_not_run.py"}}
        self.write_package()
        with patch("subprocess.Popen", side_effect=AssertionError("started process")), \
                patch("socket.socket", side_effect=AssertionError("network used")):
            package = load_package(self.package)
        self.assertEqual(package.descriptor.backend_id, self.descriptor["backend_id"])
        self.assertEqual(package.manifest["contributions"], self.manifest["contributions"])

    def test_every_required_method_is_enforced(self):
        for method in REQUIRED_METHODS:
            with self.subTest(method=method):
                value = minimal_descriptor()
                value["methods"].remove(method)
                with self.assertRaises(ContractError):
                    validate_descriptor(value)

    def test_minimal_backend_and_unknown_optional_namespace(self):
        value = minimal_descriptor()
        value["extensions"] = {"future.optional": {"v": 1}}
        descriptor = validate_descriptor(value)
        with self.assertRaises(BackendError) as error:
            descriptor.require("compact")
        self.assertEqual(error.exception.code, "unsupported_capability")
        with self.assertRaises(TypeError):
            descriptor.capabilities["compact"] = True

    def test_capability_and_method_consistency(self):
        for capability, method in CAPABILITY_METHODS.items():
            with self.subTest(capability=capability):
                value = minimal_descriptor()
                value["capabilities"][capability] = True
                if capability in ("queue_reorder", "queue_withdraw"):
                    value["capabilities"]["queue_inspect"] = True
                    value["methods"].append("queue.snapshot")
                with self.assertRaises(ContractError):
                    validate_descriptor(value)
                value["methods"].append(method)
                self.assertEqual(validate_descriptor(value).require(capability), method)

    def test_attachments_require_readable_resources(self):
        value = minimal_descriptor()
        value["capabilities"]["attachments"] = True
        with self.assertRaises(ContractError):
            validate_descriptor(value)

    def test_incompatible_package_does_not_poison_another(self):
        self.manifest["host_protocol"] = 2
        self.write_package()
        with self.assertRaises(ContractError):
            load_package(self.package)
        self.manifest["host_protocol"] = 1
        self.write_package()
        self.assertIsNotNone(load_package(self.package).descriptor)

    def test_protocol_and_field_types_fail_closed(self):
        for key, value in (("protocol_version", 2), ("protocol_version", True),
                           ("methods", "inputs.submit"), ("backend_id", "../private")):
            d = minimal_descriptor()
            d[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ContractError):
                validate_descriptor(d)

    def test_ownership_cannot_move_to_host(self):
        for key in self.descriptor["ownership"]:
            d = copy.deepcopy(self.descriptor)
            d["ownership"][key] = "host"
            with self.subTest(owner=key), self.assertRaises(ContractError):
                validate_descriptor(d)

    def test_path_escape_and_missing_entry_rejected(self):
        for path in ("../outside.json", "/etc/passwd", "C:/private.json", "..\\secret", "a//b", "missing"):
            with self.subTest(path=path), self.assertRaises(ContractError):
                package_file(self.package, path)
        self.manifest["runtime"]["command"][1] = "missing.py"
        self.write_package()
        with self.assertRaises(ContractError):
            load_package(self.package)

    def test_link_escape_rejected_without_requiring_windows_symlink_privilege(self):
        outside = self.package.parent / "outside.json"
        original_resolve = Path.resolve
        def resolve(path, *args, **kwargs):
            if path == self.package / "alias.json":
                return outside
            return original_resolve(path, *args, **kwargs)
        with patch.object(Path, "resolve", resolve), self.assertRaises(ContractError):
            package_file(self.package, "alias.json")

    def test_invalid_static_documents_and_identity(self):
        (self.package / "module.json").write_text('{"id":"a","id":"b"}', encoding="utf-8")
        with self.assertRaises(ContractError):
            load_package(self.package)
        self.descriptor["backend_id"] = "different-backend"
        self.write_package()
        with self.assertRaises(ContractError):
            load_package(self.package)

    def test_config_schema_does_not_resolve_remote_references(self):
        self.manifest["config_schema"] = "config.json"
        self.write_package()
        (self.package / "config.json").write_text('{"$ref":"https://invalid.example/schema"}', encoding="utf-8")
        with patch("socket.socket", side_effect=AssertionError("network")), self.assertRaises(ContractError):
            load_package(self.package)

    def test_external_service_validation_is_offline_and_checks_port(self):
        self.manifest["runtime"] = {"mode": "external_service", "transport": "loopback_http",
                                    "start": "on_demand", "endpoint": "http://127.0.0.1:43210/"}
        self.write_package()
        with patch("socket.socket", side_effect=AssertionError("network")):
            load_package(self.package)
        self.manifest["runtime"]["endpoint"] = "http://127.0.0.1:99999/"
        self.write_package()
        with self.assertRaises(ContractError):
            load_package(self.package)

    def test_json_is_bounded_strict_and_does_not_echo_content(self):
        for data in (b'{"x":NaN}', b'{"x":1,"x":2}', b'\xff'):
            with self.assertRaises(ContractError):
                decode_json(data)
        with self.assertRaises(ContractError):
            bounded_json({"huge": "x" * 100}, limit=20)
        value = []
        for _ in range(66):
            value = [value]
        with self.assertRaises(ContractError):
            bounded_json(value)
        d = minimal_descriptor()
        d["unexpected"] = "sensitive-test-value"
        with self.assertRaises(ContractError) as error:
            validate_descriptor(d)
        self.assertNotIn("sensitive-test-value", str(error.exception))

    def test_native_ids_are_opaque_and_bounded(self):
        e = example("backend-events")[3]
        for key in ("native_input_id", "native_run_id"):
            e[key] = "原生 / opaque?value=1"
        e["conversation_ref"]["native_conversation_id"] = "thread / A"
        validate_event(e)
        for value in ("", "x" * 241, "embedded\nline", "trailing\n", "\x00"):
            e["native_run_id"] = value
            with self.subTest(value=value), self.assertRaises(ContractError):
                validate_event(e)

    def test_public_message_order_revision_ownership_and_replacement(self):
        e = example("backend-events")[4]
        validate_event(e)
        e["payload"]["message"]["revision"] = 2
        e["payload"]["message"]["text"] = "full replacement"
        validate_event(e)
        self.assertEqual(e["payload"]["message"]["order"], 1)
        del e["payload"]["message"]["order"]
        with self.assertRaises(ContractError):
            validate_event(e)
        e = example("backend-events")[4]
        e["payload"]["message"]["request_id"] = "another-input"
        with self.assertRaises(ContractError):
            validate_event(e)

    def test_cross_instance_event_rejected(self):
        e = example("backend-events")[0]
        e["conversation_ref"]["backend_instance_id"] = "other"
        with self.assertRaises(ContractError):
            validate_event(e)

    def test_datetime_validation_does_not_need_optional_packages(self):
        e = example("backend-events")[0]
        for value in ("yesterday", "2026-02-30T10:00:00Z", "2026-10-30T10:00:00", "2026-10-30T10:00:00+02:99"):
            e["occurred_at"] = value
            with self.subTest(value=value), self.assertRaises(ContractError):
                validate_event(e)
        e["occurred_at"] = "2026-10-30T10:00:00Z"
        validate_event(e)

    def resource(self):
        return {"id":"opaque / resource", "backend_instance_id":"backend-01",
                "conversation_id":"conversation-01", "mime_type":"text/plain",
                "size_bytes":5,"expires_at":None}

    def test_resource_and_text_are_exclusive_and_reference_scoped(self):
        e = example("backend-events")[4]
        message = e["payload"]["message"]
        message["resource_ref"] = self.resource()
        with self.assertRaises(ContractError):
            validate_message(message)
        del message["text"]
        validate_event(e)
        message["resource_ref"]["conversation_id"] = "another"
        with self.assertRaises(ContractError):
            validate_event(e)

    def test_resource_ranges_and_chunks_are_bounded(self):
        request = {"principal_id":"principal-01", "conversation_ref":example("backend-events")[0]["conversation_ref"],
                   "resource_ref":self.resource(),"offset":0,"limit":5}
        validate_resource_read(request)
        for value in (0, 262145):
            request["limit"] = value
            with self.assertRaises(ContractError):
                validate_resource_read(request)
        chunk = {"resource_ref":self.resource(),"offset":0,
                 "data_base64":base64.b64encode(b"hello").decode(),"eof":True}
        validate_resource_chunk(chunk)
        request["limit"] = 1
        with self.assertRaises(ContractError):
            validate_resource_chunk(chunk, request)
        chunk["offset"] = 1
        with self.assertRaises(ContractError):
            validate_resource_chunk(chunk)
        chunk["offset"] = 0
        chunk["eof"] = False
        with self.assertRaises(ContractError):
            validate_resource_chunk(chunk)

    def test_public_error_has_explicit_nonretry_default(self):
        error = BackendError("request_unknown", "Check original request", request_id="input-1",
                             retry_policy=RetryPolicy.QUERY_ORIGINAL)
        self.assertEqual(error.to_dict()["retry_policy"], "query_original")
        self.assertEqual(BackendError("permission_denied", "Denied").retry_policy, "never")


if __name__ == "__main__":
    unittest.main()
