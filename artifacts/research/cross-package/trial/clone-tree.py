#!/usr/bin/env python3
"""Clone admitted fixture entries through macOS clonefile without following links."""
import argparse
import ctypes
import json
import os
import stat
import time
from pathlib import Path


def clone_tree(source, destination, exclude_git=True):
    source, destination = Path(source).absolute(), Path(destination).absolute()
    if not source.is_dir() or source.is_symlink() or destination.exists() or destination.is_symlink():
        raise ValueError('Source must be a real directory and destination must not exist')
    source = source.resolve(strict=True)
    destination = destination.parent.resolve(strict=True) / destination.name
    if destination == source or source in destination.parents:
        raise ValueError('Destination must remain outside source')
    library = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    clone = library.clonefile
    clone.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
    clone.restype = ctypes.c_int
    started = time.monotonic()
    receipt = {'source': str(source), 'destination': str(destination), 'mechanism': 'macOS clonefile(2) per file and symlink, CLONE_NOFOLLOW=1, no copy fallback', 'clonedFiles': 0, 'clonedSymlinks': 0, 'directories': 0, 'excludedGit': []}

    def walk(src, dst):
        info = src.lstat()
        if stat.S_ISDIR(info.st_mode):
            if exclude_git and src.name == '.git':
                receipt['excludedGit'].append({'path': str(src.relative_to(source)), 'kind': 'directory', 'admitted': False})
                return
            dst.mkdir()
            for item in sorted(src.iterdir(), key=lambda path: path.name):
                walk(item, dst / item.name)
            os.chmod(dst, stat.S_IMODE(info.st_mode))
            receipt['directories'] += 1
            return
        if not (stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)):
            raise ValueError('Special file cannot be cloned: ' + str(src))
        if src.name == '.git':
            raise ValueError('Unexpected Git metadata pointer needs independent review')
        if clone(os.fsencode(src), os.fsencode(dst), 1) != 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error), str(src))
        after = dst.lstat()
        if (info.st_dev, info.st_ino) == (after.st_dev, after.st_ino):
            raise ValueError('Clone must have independent file identity')
        if stat.S_IMODE(info.st_mode) != stat.S_IMODE(after.st_mode):
            raise ValueError('Clone mode differs')
        if stat.S_ISLNK(info.st_mode):
            if os.readlink(src) != os.readlink(dst):
                raise ValueError('Symlink text differs')
            receipt['clonedSymlinks'] += 1
        else:
            receipt['clonedFiles'] += 1
    walk(source, destination)
    receipt['elapsedMs'] = (time.monotonic() - started) * 1000
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source')
    parser.add_argument('destination')
    parser.add_argument('--receipt')
    args = parser.parse_args()
    result = clone_tree(args.source, args.destination)
    if args.receipt:
        Path(args.receipt).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
