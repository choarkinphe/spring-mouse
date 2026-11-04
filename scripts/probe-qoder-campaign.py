"""Authorized one-shot eligibility and explicit single-claim verification. No secrets on stdout."""
import argparse, hashlib, json, os, pathlib, selectors, sqlite3, subprocess, urllib.request, urllib.error, urllib.parse, uuid, time
p = argparse.ArgumentParser()
p.add_argument('--binary', required=True)
p.add_argument('--state-dir', required=True)
p.add_argument('--db', required=True)
p.add_argument('--claim-slot', type=int, default=0, help='Explicitly claim only this eligible account slot, once')
a = p.parse_args()
assert hashlib.sha256(pathlib.Path(a.binary).read_bytes()).hexdigest() == 'e30b307eaae12680d2f4e220d4d34b0ea4f70355a624d6d55ee916e03f7d7478'
root = pathlib.Path(a.state_dir)
root.mkdir(mode=0o700, parents=True, exist_ok=True)
mid = root / 'machine-id'
if not mid.exists(): mid.write_text(str(uuid.uuid4()))
process = subprocess.Popen([str(pathlib.Path(a.binary).resolve()), '4'], cwd=root, env={**os.environ, 'HOME': str(root)}, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
selector = selectors.DefaultSelector()
selector.register(process.stdout, selectors.EVENT_READ)
try:
    assert selector.select(30), 'native initialization timeout'
    line = process.stdout.readline(65536)
    identity = json.loads(line)
    for key in ['machineToken', 'machineType', 'machineCode']:
        assert isinstance(identity.get(key), str) and identity[key] and len(identity[key]) < 8192
finally:
    process.terminate()
    try: process.wait(timeout=3)
    except subprocess.TimeoutExpired: process.kill(); process.wait()
with sqlite3.connect('file:' + a.db + '?mode=ro', uri=True, timeout=10) as db:
    accounts = db.execute('SELECT id, data FROM providerConnections WHERE provider=? AND isActive=1 ORDER BY priority', ('qoder',)).fetchall()
for index, (_, raw) in enumerate(accounts):
    saved = json.loads(raw)
    token = saved.get('accessToken')
    if not token or not token.startswith(('dt-', 'jt-')):
        print(json.dumps({'accountSlot': index + 1, 'skipped': 'unsupported_saved_token'})); continue
    headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/json', 'User-Agent': 'Qoder', 'Cosy-ClientType': '10', 'Cosy-Version': '1.1.82', 'Cosy-MachineOS': 'x86_64_linux', 'Cosy-MachineId': mid.read_text().strip(), 'Cosy-MachineHostname': os.uname().nodename, 'Cosy-MachineToken': identity['machineToken'], 'Cosy-MachineType': identity['machineType'], 'Cosy-MachineCode': identity['machineCode']}
    try:
        request = urllib.request.Request('https://openapi.qoder.sh/sash/api/v1/me/campaigns', headers=headers)
        with urllib.request.urlopen(request, timeout=20) as response:
            body = json.load(response)
            campaigns = body.get('campaigns', [])
            print(json.dumps({'accountSlot': index + 1, 'httpStatus': response.status, 'nativeIdentity': True, 'isVm': identity.get('vmInfo', {}).get('isVm'), 'campaigns': [{'actionType': c.get('actionType'), 'claimStatus': c.get('claimStatus'), 'benefit': c.get('benefit'), 'startAt': c.get('startAt'), 'endAt': c.get('endAt')} for c in campaigns], 'claimSent': False}))
            if a.claim_slot == index + 1:
                eligible = [c for c in campaigns if c.get('actionType') == 'CLAIM_BENEFIT' and c.get('claimStatus') == 'CLAIMABLE' and c.get('benefit', {}).get('kind') == 'CREDITS' and isinstance(c.get('startAt'), (int, float)) and isinstance(c.get('endAt'), (int, float)) and c['startAt'] <= time.time() < c['endAt']]
                if len(eligible) != 1:
                    print(json.dumps({'accountSlot': index + 1, 'claimSent': False, 'reason': 'no_unique_active_claimable_campaign'})); continue
                campaign = eligible[0]
                cid = campaign.get('campaignId')
                assert isinstance(cid, str) and 0 < len(cid) <= 256
                claim_url = 'https://openapi.qoder.sh/sash/api/v1/me/campaigns/' + urllib.parse.quote(cid, safe='') + '/claim'
                claim = urllib.request.Request(claim_url, data=b'{}', headers={**headers, 'Content-Type': 'application/json'}, method='POST')
                # One request only. No retry after rejection or ambiguous failure.
                with urllib.request.urlopen(claim, timeout=20) as response:
                    claimed = json.load(response)
                    reply = claimed.get('data', claimed)
                    print(json.dumps({'accountSlot': index + 1, 'claimSent': True, 'claimHttp': response.status, 'claimStatus': reply.get('status'), 'reward': reply.get('benefit', {}).get('amount')}))
                with urllib.request.urlopen(request, timeout=20) as response:
                    verified = json.load(response).get('campaigns', [])
                    status = next((c.get('claimStatus') for c in verified if c.get('campaignId') == cid), None)
                    print(json.dumps({'accountSlot': index + 1, 'verifiedClaimStatus': status}))
                usage_req = urllib.request.Request('https://openapi.qoder.sh/api/v2/quota/usage', headers=headers)
                with urllib.request.urlopen(usage_req, timeout=20) as response:
                    usage = json.load(response)
                    print(json.dumps({'accountSlot': index + 1, 'addOnAfter': {k: usage.get('addOnQuota', {}).get(k) for k in ['total', 'used', 'remaining']}}))

    except urllib.error.HTTPError as error:
        print(json.dumps({'accountSlot': index + 1, 'httpStatus': error.code, 'nativeIdentity': True, 'claimSent': False}))
