"""Import the recovered native renderer after checking the complete payload hash.

The small binary fragments are transport only, not a replacement for readable
source. The final fragment's duplicate 9-byte transport run is corrected before
checking the SHA-256 of the original unmodified source archive.
"""
from pathlib import Path, PurePosixPath
import hashlib
import io
import json
import tarfile

ROOT = Path(__file__).resolve().parents[1]
EXPECTED = 'e9ae5ceb0421fb64614ec37c52e48da2c2fd3da4a2c3a26a359cafbd864be5a4'

def main():
    parts = [(ROOT / 'publication' / 'baseline' / f'{i:02}.part').read_bytes() for i in range(12)]
    if len(parts[-1]) != 4068:
        raise ValueError('Unexpected final transport fragment length')
    parts[-1] = parts[-1][:4047] + parts[-1][4056:]
    data = b''.join(parts)
    digest = hashlib.sha256(data).hexdigest()
    if digest != EXPECTED:
        raise ValueError(f'Source payload checksum mismatch: {digest}')
    files = []
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive.getmembers():
            rel = PurePosixPath(member.name)
            if not member.isfile() or rel.is_absolute() or '..' in rel.parts:
                raise ValueError(f'Unsafe archive member: {rel}')
            if rel.parts[0] not in {'src','tests','tools','CMakeLists.txt','requirements.txt'}:
                raise ValueError(f'Unexpected source destination: {rel}')
            payload = archive.extractfile(member).read()
            payload.decode('utf-8')
            target = ROOT.joinpath(*rel.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
            files.append({'path':str(rel),'sha256':hashlib.sha256(payload).hexdigest(),'bytes':len(payload)})
    if len(files) != 20:
        raise ValueError('Incomplete source import')
    (ROOT/'reports').mkdir(exist_ok=True)
    (ROOT/'reports'/'source-import.json').write_text(json.dumps({'archive_sha256':digest,'files':files,'source':'restored native C++ renderer','binary_scene_and_movies_uploaded':False},indent=2)+'\n')
    print(f'Imported {len(files)} exact source files; SHA-256 {digest}')

if __name__ == '__main__':
    main()
