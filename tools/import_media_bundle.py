#!/usr/bin/env python3
"""Install a SHA-256-verified forest media bundle; never execute archive files."""
from __future__ import annotations
import argparse,hashlib,json,os,shutil,stat,tempfile,zipfile
from pathlib import Path,PurePosixPath
MAX_TOTAL=2_000_000_000
MAX_FILE=104_000_000

def digest(p:Path)->str:
    h=hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
    return h.hexdigest()

def import_bundle(source:Path,checksum:str,root:Path)->dict:
    if len(checksum)!=64 or digest(source)!=checksum.lower():raise ValueError('Bundle SHA-256 mismatch')
    root=root.resolve()
    with zipfile.ZipFile(source) as z,tempfile.TemporaryDirectory() as tmp:
        stage=Path(tmp);total=0;seen=set();allowed=[]
        for m in z.infolist():
            p=PurePosixPath(m.filename)
            if p.is_absolute() or '..' in p.parts or '\\' in m.filename or not p.parts:raise ValueError('Unsafe archive path')
            if stat.S_ISLNK(m.external_attr>>16):raise ValueError('Symlink rejected')
            if m.is_dir():continue
            if m.filename in seen:raise ValueError('Duplicate archive path')
            seen.add(m.filename)
            if p.parts[0] not in ('assets','media','reports') or any(x.startswith('.') for x in p.parts):raise ValueError('Unexpected archive member')
            if p.suffix.lower() not in ('.glb','.cys','.tex','.irr','.vol','.mp4','.gif','.png','.jpg','.json','.exr'):raise ValueError('Unexpected media extension')
            total+=m.file_size
            if m.file_size>MAX_FILE or total>MAX_TOTAL:raise ValueError('Size limit exceeded')
            dest=stage/m.filename;dest.parent.mkdir(parents=True,exist_ok=True)
            with z.open(m) as inf,dest.open('wb') as out:shutil.copyfileobj(inf,out)
            allowed.append(m.filename)
        manifest=json.loads((stage/'reports/publication-manifest.json').read_text())
        entries={x['path']:x for x in manifest['files']}
        if set(allowed)!=set(entries)|{'reports/publication-manifest.json'}:raise ValueError('Archive and manifest membership differ')
        for rel,item in entries.items():
            p=stage/rel
            if p.stat().st_size!=item['bytes'] or digest(p)!=item['sha256']:raise ValueError('Payload verification failed: '+rel)
        for rel in allowed:
            target=root/rel
            if target.is_symlink() or any(p.is_symlink() for p in target.parents if p!=root.parent):raise ValueError('Destination symlink rejected')
        for rel in allowed:
            dst=root/rel;dst.parent.mkdir(parents=True,exist_ok=True);os.replace(stage/rel,dst)
    report={'bundle_sha256':checksum,'verified_files':len(entries),'verified_bytes':total,'uploaded_media_manifest_verified':True,'full_convergence_certified':False}
    (root/'reports/media-import.json').write_text(json.dumps(report,indent=2)+'\n')
    return report

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--file',type=Path,required=True);ap.add_argument('--sha256',required=True);ap.add_argument('--root',type=Path,default=Path.cwd());a=ap.parse_args()
    print(json.dumps(import_bundle(a.file,a.sha256,a.root),indent=2))
if __name__=='__main__':main()
