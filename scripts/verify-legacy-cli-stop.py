import json, os, subprocess, sys
from datetime import datetime
from pathlib import Path

NAME = 'paperclip-consolidated-candidate'
SERVICE = 'consolidated-paperclip'
BASE = 'sha256:165ef7671ee5bde31ad28140b6fd45cd70594da48e10b9cb363c1fe8c4098472'
CONTRACT = {
    'packages/adapters/codex-local/src/server/execute.ts': '581f1384f4c10501d01f2cbdcb866686eec1283c',
    'server/src/services/heartbeat/run-output.ts': '249db52646e055dcfdc6279c80d0c27603368811',
    'server/src/services/heartbeat/runtime-execution.ts': '067b7fa1198c401cd41e316cc66aa522151b997c',
    'server/src/services/heartbeat.ts': '6472c6b86121af27f0a7f756dfe094b68e1feeaa',
}

def run(args, text=None):
    p = subprocess.run(args, input=text, capture_output=True, text=True)
    if p.returncode:
        raise RuntimeError('operator_command_failed:' + args[0])
    return p.stdout

def main():
    mode, root_arg, scope_arg = sys.argv[1:]
    assert mode in ('inspect', 'record')
    root = Path(root_arg).resolve()
    scope = json.loads(Path(scope_arg).read_text())
    assert set(scope) == {'companyId', 'issueId', 'runId', 'recoveryActionId'}, 'INVALID_SOURCE_SCOPE'
    manifest = json.loads((root / 'manifest.json').read_text())
    c = json.loads(run(['docker', 'inspect', NAME]))[0]
    assert c['Image'] == BASE and c['State']['Running'], 'SOURCE_CONTROLLER_CHANGED'
    assert c['Config']['Labels']['com.docker.compose.service'] == SERVICE
    assert c['Config']['Labels']['com.docker.compose.project.config_files'].split(',') == manifest['compose_files']
    code_paths = ['/app/' + p for p in CONTRACT] + ['/app/server/dist', '/app/server/dist-runtime', '/app/packages/adapters/codex-local/dist']
    for mount in c['Mounts']:
        dest = mount['Destination'].rstrip('/')
        assert not any(p == dest or p.startswith(dest + '/') or dest.startswith(p + '/') for p in code_paths), 'SOURCE_CODE_MOUNTED'
    diffs = run(['docker', 'diff', NAME]).splitlines()
    assert not any(line[2:] == '/app' or line[2:].startswith('/app/') for line in diffs), 'SOURCE_APP_FILES_CHANGED'
    js = 'const fs=require("fs"),c=require("crypto"),out={};for(const p of '+json.dumps(list(CONTRACT))+' ){const b=fs.readFileSync(p);out[p]=c.createHash("sha1").update(Buffer.from("blob "+b.length+String.fromCharCode(0))).update(b).digest("hex")}console.log(JSON.stringify(out));'
    blobs = json.loads(run(['docker', 'exec', NAME, 'node', '-e', js]))
    assert blobs == CONTRACT, 'SOURCE_CONTRACT_CHANGED'
    request = {'mode': mode, **scope,
        'observation': {'imageId': c['Image'], 'containerId': c['Id'], 'containerStartedAt': datetime.fromisoformat(c['State']['StartedAt'].replace('Z', '+00:00')).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
            'appMountsAbsent': True, 'appDiffAbsent': True, 'sourceBlobs': blobs}}
    cmd = ['docker', 'compose', '-p', 'paperclip']
    for p in manifest['compose_files']: cmd += ['-f', p]
    cmd += ['-f', str(root / 'candidate.override.json'), 'run', '--rm', '--no-deps', '-T', '--pull', 'never',
        '--entrypoint', 'node', SERVICE, '/app/server/scripts/operator/verify-legacy-cli-stop.mjs']
    result = json.loads(run(cmd, json.dumps(request)))
    if mode == 'record':
        path = root / 'legacy-stop-receipt.json'
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as f: json.dump(result, f, sort_keys=True, indent=2)
    print(json.dumps(result))

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print('LEGACY_STOP_VERIFICATION_FAILED:' + str(error), file=sys.stderr)
        raise SystemExit(1)
