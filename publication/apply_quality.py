#!/usr/bin/env python3
"""Recover the exact tested readable upgrade, protecting concurrent edits."""
import base64,hashlib,json,lzma,subprocess,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
BUNDLE=ROOT/'publication/quality'
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
def main():
    manifest=json.loads((BUNDLE/'manifest.json').read_text())
    desired=manifest['result_files']
    for name in desired:
        p=Path(name)
        if p.is_absolute() or '..' in p.parts:raise ValueError('Invalid destination')
    if all(sha(ROOT/p)==h for p,h in desired.items()):
        print('Upgrade already materialized and byte-verified.');return
    for name,expected in manifest['base_files'].items():
        if sha(ROOT/name)!=expected:raise RuntimeError('Baseline changed; refusing to overwrite '+name)
    encoded=''.join((BUNDLE/f'{i:02}.part').read_text() for i in range(5))
    if len(encoded)>100000:raise ValueError('Oversized payload')
    decoder=lzma.LZMADecompressor(memlimit=128*1024*1024)
    patch=decoder.decompress(base64.b85decode(encoded),max_length=1000000)
    if not decoder.eof or decoder.unused_data or hashlib.sha256(patch).hexdigest()!=manifest['patch_sha256']:raise ValueError('Patch checksum/length mismatch')
    with tempfile.NamedTemporaryFile(suffix='.patch') as f:
        f.write(patch);f.flush()
        subprocess.run(['git','apply','--check',f.name],cwd=ROOT,check=True)
        subprocess.run(['git','apply',f.name],cwd=ROOT,check=True)
    for name,expected in desired.items():
        if sha(ROOT/name)!=expected:raise RuntimeError('Recovered source mismatch: '+name)
    print('Recovered and SHA-256 verified',len(desired),'readable source files.')
if __name__=='__main__':main()
