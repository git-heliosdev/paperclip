#!/usr/bin/python3
import hashlib
import json
import os
import re
import stat
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

REAL_CODEX = '/usr/local/lib/node_modules/@openai/codex/bin/codex.js'
MAX_INPUT = 16 * 1024 * 1024


def main():
    args = sys.argv[1:]
    if 'exec' not in args or not args or args[-1] != '-':
        os.execv(REAL_CODEX, [REAL_CODEX, *args])
    trace = Path('/tmp/paperclip-codex-stdin-guard-' + str(os.getuid()))
    trace.mkdir(mode=0o700, exist_ok=True)
    info = trace.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError('unsafe_stdin_trace_directory')
    digest = hashlib.sha256()
    count = 0
    with tempfile.TemporaryFile(mode='w+b', dir=trace) as buffered:
        while True:
            chunk = sys.stdin.buffer.read(65536)
            if not chunk:
                break
            count += len(chunk)
            if count > MAX_INPUT:
                print('Codex instruction input exceeded the guarded limit.', file=sys.stderr)
                return 78
            digest.update(chunk)
            buffered.write(chunk)
        run = os.environ.get('PAPERCLIP_RUN_ID', '')
        if not re.fullmatch(r'[a-f0-9-]{36}', run):
            run = 'unscoped'
        record = {'schema': 'paperclip.codex-stdin-guard.v1', 'runId': run,
                  'bytesReceived': count, 'sha256': digest.hexdigest(),
                  'stdinMode': 'private_unlinked_file',
                  'observedAt': datetime.now(timezone.utc).isoformat()}
        target = trace / (run + '-' + str(uuid.uuid4()) + '.json')
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as output:
            json.dump(record, output, sort_keys=True)
        if count == 0:
            print('No prompt provided via stdin. Input guard received zero bytes.', file=sys.stderr)
            return 78
        buffered.seek(0)
        os.dup2(buffered.fileno(), 0, inheritable=True)
        os.execv(REAL_CODEX, [REAL_CODEX, *args])


if __name__ == '__main__':
    raise SystemExit(main())
