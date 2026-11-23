"""Publishes notices, plus a backup check. The main checks run every 5 minutes
in worker/worker.js (Cloudflare), which also records automatic incidents.
Incidents and maintenance are GitHub issues labelled 'incident' or 'maintenance';
only ones created by the repository owner or by this workflow are shown."""
import json, os, random, re, socket, ssl, struct, time, urllib.request
from datetime import datetime, timezone

def http(url, want=None):
    r = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'vagocat-status'}), timeout=20)
    body = r.read(200000).decode('utf-8', 'replace')
    return r.status == 200 and (want is None or want in body)

def tls(host, port):
    with socket.create_connection((host, port), 15) as s:
        with ssl.create_default_context().wrap_socket(s, server_hostname=host):
            return True

def dns(server, name):
    q = struct.pack('>HHHHHH', random.randrange(65536), 0, 1, 0, 0, 0)
    q += b''.join(bytes([len(p)]) + p.encode() for p in name.split('.')) + b'\0' + struct.pack('>HH', 6, 1)
    with socket.create_connection((server, 53), 15) as s:
        s.sendall(struct.pack('>H', len(q)) + q)
        f = s.makefile('rb')
        n = struct.unpack('>H', f.read(2))[0]
        a = f.read(n)
    return a[:2] == q[:2] and a[3] & 15 == 0 and struct.unpack('>H', a[6:8])[0] > 0

SERVICES = [
    ('DNS / Domains', [lambda: dns('erebus.vagocat.com', 'gracivo.org')]),
    ('Email', [lambda: http('https://webmail.vagocat.com/'), lambda: tls('mail.vagocat.com', 993), lambda: tls('mail.vagocat.com', 465)]),
    ('Hosting', [lambda: http('https://gracivo.org/vc-check', 'vc-42')]),
    ('Control Panel', [lambda: http('https://panel.vagocat.com:8083/login/')]),
    ('Account Manager', [lambda: http('https://my.vagocat.com/login')]),
    ('Website', [lambda: http('https://vagocat.com/api/health/', 'ok')]),
]

def ok(fn):
    for i in range(3):
        try:
            if fn():
                return True
        except Exception as e:
            print('attempt', i + 1, type(e).__name__, getattr(e, 'code', ''))
        time.sleep(15)
    return False

REPO = os.environ['GITHUB_REPOSITORY']
def api(path, data=None, method=None):
    r = urllib.request.Request('https://api.github.com/repos/%s/%s' % (REPO, path), method=method,
        data=json.dumps(data).encode() if data else None,
        headers={'Authorization': 'Bearer ' + os.environ['GITHUB_TOKEN'], 'Accept': 'application/vnd.github+json'})
    return json.load(urllib.request.urlopen(r, timeout=30))

now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
BOT = 'github-actions[bot]'
trusted = {REPO.split('/')[0], BOT}
result = []
for name, checks in SERVICES:
    r = [ok(c) for c in checks]
    state = 'operational' if all(r) else 'partial' if any(r) else 'major'
    result.append({'name': name, 'state': state})
    print(name, state)

notices = []
for i in api('issues?state=all&per_page=100&sort=created&direction=desc'):
    labels = {l['name'] for l in i['labels']}
    kind = 'incident' if 'incident' in labels else 'maintenance' if 'maintenance' in labels else None
    if kind and i['user']['login'] in trusted and 'pull_request' not in i:
        notices.append({'kind': kind, 'title': i['title'], 'body': re.sub(r'<!--.*?-->', '', i['body'] or '', flags=re.S)[:1500],
            'opened': i['created_at'], 'closed': i['closed_at'], 'updated': i['updated_at']})
json.dump({'checked': now, 'services': result, 'notices': notices}, open('status.json', 'w'))
