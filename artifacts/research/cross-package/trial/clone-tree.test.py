import importlib.util
import tempfile
import ctypes
import errno
from types import SimpleNamespace
from unittest.mock import patch
import unittest
from pathlib import Path
spec = importlib.util.spec_from_file_location('clone', Path(__file__).with_name('clone-tree.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class NativeCloneTests(unittest.TestCase):
    def test_exact_independent_files_links_and_git_exclusion(self):
        with tempfile.TemporaryDirectory(prefix='typelatch-native-clone-') as directory:
            root = Path(directory); source = root / 'source'; source.mkdir()
            (source / 'a.ts').write_text('original\n')
            (source / 'a.ts').chmod(0o755)
            (source / 'alias').symlink_to('a.ts')
            (source / '.git').mkdir(); (source / '.git/config').write_text('old history')
            (source / 'nested').mkdir(); (source / 'nested/.git').mkdir()
            target = root / 'target'
            receipt = module.clone_tree(source, target)
            self.assertEqual((target / 'a.ts').read_bytes(), (source / 'a.ts').read_bytes())
            self.assertEqual((target / 'alias').readlink(), Path('a.ts'))
            self.assertEqual({row['path'] for row in receipt['excludedGit']}, {'.git', 'nested/.git'})
            self.assertNotEqual((target / 'a.ts').stat().st_ino, (source / 'a.ts').stat().st_ino)
            (target / 'a.ts').write_text('clone changed\n')
            self.assertEqual((source / 'a.ts').read_text(), 'original\n')
            self.assertEqual((target / 'a.ts').stat().st_mode & 0o777, 0o755)

    def test_existing_dangling_or_nested_destination_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix='typelatch-native-clone-') as directory:
            root=Path(directory); source=root/'source'; source.mkdir(); (source/'a').write_text('x')
            occupied=root/'occupied'; occupied.mkdir()
            dangling=root/'dangling'; dangling.symlink_to('missing')
            for destination in (occupied,dangling,source/'nested'):
                with self.assertRaises(ValueError): module.clone_tree(source,destination)
            self.assertEqual((source/'a').read_text(),'x')

    def test_native_failure_has_no_copy_fallback(self):
        with tempfile.TemporaryDirectory(prefix='typelatch-native-clone-') as directory:
            root=Path(directory); source=root/'source'; source.mkdir(); (source/'a').write_text('x')
            destination=root/'target'
            def failed(*args): ctypes.set_errno(errno.ENOTSUP); return -1
            with patch.object(module.ctypes,'CDLL',return_value=SimpleNamespace(clonefile=failed)):
                with self.assertRaises(OSError) as failure: module.clone_tree(source,destination)
            self.assertEqual(failure.exception.errno,errno.ENOTSUP)
            self.assertFalse((destination/'a').exists())
            self.assertEqual((source/'a').read_text(),'x')

if __name__ == '__main__':
    unittest.main()
