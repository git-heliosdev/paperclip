"""Pin the existing controller rollout contract without printing environment values."""
import hashlib, json, os, subprocess, sys
from pathlib import Path

NAME = 'paperclip-consolidated-candidate'
SERVICE = 'consolidated-paperclip'
BASE = 'sha256:165ef7671ee5bde31ad28140b6fd45cd70594da48e10b9cb363c1fe8c4098472'

def run(args):
    p = subprocess.run(args, capture_output=True, text=True)
    if p.returncode:
        raise RuntimeError('COMMAND_FAILED:' + args[0])
    return p.stdout

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def private_json(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(value, f, sort_keys=True, indent=2)

def settings(c):
    cfg = c['Config']; host = c['HostConfig']
    out = {k: digest(cfg.get(k)) for k in ('User', 'WorkingDir', 'Cmd', 'Entrypoint', 'Healthcheck', 'ExposedPorts')}
    out['Env'] = digest(sorted(cfg.get('Env') or []))
    for k in ('Binds', 'ReadonlyRootfs', 'CapAdd', 'CapDrop', 'SecurityOpt', 'NetworkMode', 'PortBindings', 'Memory', 'MemorySwap', 'NanoCpus', 'PidsLimit', 'Tmpfs', 'RestartPolicy', 'LogConfig', 'Privileged', 'Devices', 'ExtraHosts', 'Dns'):
        v = host.get(k)
        if k in ('Binds', 'CapAdd', 'CapDrop', 'SecurityOpt') and isinstance(v, list):
            v = sorted(v)
        out['Host.' + k] = digest(v)
    out['Mounts'] = digest(sorted([{k: m.get(k) for k in ('Type', 'Source', 'Destination', 'RW', 'Propagation')} for m in c['Mounts']], key=lambda m: m['Destination']))
    out['Networks'] = digest(sorted(c['NetworkSettings']['Networks']))
    return out

def main():
    mode, root_arg, candidate = sys.argv[1:]
    assert mode in ('before', 'after') and candidate.startswith('sha256:') and len(candidate) == 71
    root = Path(root_arg).resolve()
    assert root.is_dir() and root.stat().st_uid == os.getuid()
    c = json.loads(run(['docker', 'inspect', NAME]))[0]
    assert c['State']['Running'] and c['Config']['Labels']['com.docker.compose.service'] == SERVICE
    assert c['Image'] == (BASE if mode == 'before' else candidate), 'IMAGE_DRIFT'
    record = root / 'manifest.json'
    if mode == 'before':
        paths = c['Config']['Labels']['com.docker.compose.project.config_files'].split(',')
        assert len(paths) == 5 and all(Path(p).is_absolute() and Path(p).is_file() for p in paths)
        project = c['Config']['Labels']['com.docker.compose.project']
        assert project == 'paperclip'
        cmd = ['docker', 'compose', '-p', project]
        for p in paths: cmd += ['-f', p]
        old = json.loads(run(cmd + ['config', '--format', 'json']))
        private_json(root / 'candidate.override.json', {'services': {SERVICE: {'image': candidate}}})
        private_json(root / 'rollback.override.json', {'services': {SERVICE: {'image': BASE}}})
        new = json.loads(run(cmd + ['-f', str(root / 'candidate.override.json'), 'config', '--format', 'json']))
        expected = json.loads(json.dumps(old)); expected['services'][SERVICE]['image'] = candidate
        assert new == expected, 'RENDERED_CONFIG_CHANGED_BEYOND_IMAGE'
        private_json(record, {'base': BASE, 'candidate': candidate, 'compose_files': paths,
            'compose_sha256': {p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in paths},
            'runtime_hashes': settings(c), 'rendered_before_hash': digest(old), 'rendered_candidate_hash': digest(new)})
        print('BASELINE_AND_ROLLBACK_PINNED; five Compose inputs preserved; rendered change=image only')
    else:
        old = json.loads(record.read_text())
        assert old['candidate'] == candidate and settings(c) == old['runtime_hashes'], 'RUNTIME_SETTING_DRIFT'
        assert all(hashlib.sha256(Path(p).read_bytes()).hexdigest() == h for p, h in old['compose_sha256'].items()), 'COMPOSE_INPUT_DRIFT'
        print('CANDIDATE_IMAGE_VERIFIED; runtime settings and five original Compose inputs unchanged')

if __name__ == '__main__':
    try: main()
    except Exception as e:
        print('CONTROLLER_RUNTIME_GUARD_FAILED:' + str(e), file=sys.stderr)
        raise SystemExit(1)
