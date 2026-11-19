"""Download the official CC0 source needed to reproduce the dense grass slabs."""
from argparse import ArgumentParser
from pathlib import Path
import hashlib
import json
import urllib.request

parser = ArgumentParser()
parser.add_argument('--asset-root', type=Path, required=True)
args = parser.parse_args()
args.asset_root.mkdir(parents=True, exist_ok=True)
name = 'grass_medium_01'
folder = args.asset_root / name
folder.mkdir(exist_ok=True)
headers = {'User-Agent': 'CYBR-MeadowSourceReproduction/1.0'}

def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=90) as response:
        return response.read()

records = json.loads(fetch('https://api.polyhaven.com/files/' + name))
(args.asset_root / (name + '-files.json')).write_text(json.dumps(records, indent=2))
metadata = json.loads(fetch('https://api.polyhaven.com/info/' + name))
(args.asset_root / (name + '-info.json')).write_text(json.dumps(metadata, indent=2))
gltf = records['gltf']['1k']['gltf']
items = [(folder / (name + '.gltf'), gltf)]
items += [(folder / filename, entry) for filename, entry in gltf['include'].items() if filename.endswith('.bin')]
items += [(folder / 'Diffuse.png', records['Diffuse']['1k']['png'])]
for path, record in items:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = fetch(record['url'])
    if record.get('md5'):
        assert hashlib.md5(data).hexdigest() == record['md5'], 'Source checksum mismatch'
    path.write_bytes(data)
    print(path.name, len(data), 'bytes')
