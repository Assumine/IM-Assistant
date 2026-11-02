"""An update must not delete lazy resources belonging to an open desktop."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('desktop_release', ROOT / 'opencode/packages/im-assistant/script/desktop_release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class DesktopRelease(unittest.TestCase):
    def create_source(self, directory):
        root = Path(directory)
        files = {'package.json': '{"main":"./out/main/index.js"}',
                 'out/main/index.js': 'main', 'out/preload/index.cjs': 'preload',
                 'out/renderer/index.html': '<script src="assets/old.js"></script>',
                 'out/renderer/assets/old.js': 'old lazy route', 'resources/icon.png': 'icon'}
        for name, content in files.items():
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding='utf-8')
        return root

    def test_existing_window_resources_survive_build_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.create_source(directory)
            old = release.prepare_release(root)
            self.assertEqual(release.prepare_release(root), old)
            (root / 'out/renderer/assets/old.js').unlink()
            (root / 'out/renderer/assets/new.js').write_text('new lazy route')
            (root / 'out/renderer/index.html').write_text('<script src="assets/new.js"></script>')
            new = release.prepare_release(root)
            self.assertNotEqual(old, new)
            self.assertEqual((old / 'out/renderer/assets/old.js').read_text(), 'old lazy route')
            self.assertFalse((old / 'out/renderer/assets/new.js').exists())
            self.assertTrue((new / 'resources/icon.png').is_file())
            self.assertEqual(release.prepare_release(root), new)

    def test_partial_source_and_damaged_snapshot_are_not_launched(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.create_source(directory)
            snapshot = release.prepare_release(root)
            (snapshot / 'out/renderer/assets/old.js').unlink()
            with self.assertRaises(RuntimeError):
                release.prepare_release(root)
            (root / 'out/preload/index.cjs').unlink()
            with self.assertRaises(RuntimeError):
                release.prepare_release(root)
            self.assertEqual(list((root / '.im-releases').glob('.staging-*')), [])
