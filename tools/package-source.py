"""Package the source and assets in two parts; captured evidence is a separate part."""
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parents[1]
distribution = root / 'dist'
source, trees, captures = 'CYBR-Forest-Source.zip', 'CYBR-Forest-Trees.zip', 'CYBR-Forest-Captures.zip'
parts = {name: [] for name in (source, trees, captures)}
for path in sorted(distribution.rglob('*')):
    if not path.is_file() or path.suffix in {'.zip', '.xz'}:
        continue
    if 'impostors' in path.parts and path.name.endswith(('-albedo.bin', '-normal.bin', '-position.bin')):
        continue  # Local QA can decode the included PNGs losslessly.
    if path.is_relative_to(distribution/'evidence'):
        part = captures
    elif (path.name.startswith('near-') and path.suffix == '.bin') or path.name in {'albedo.bin', 'sky-detail.bin'}:
        part = trees
    else:
        part = source
    parts[part].append(path)
parts[source].append(root/'README.md')
for directory in ['tools', 'assets-source']:
    parts[source].extend(p for p in sorted((root/directory).rglob('*'))
                         if p.is_file() and p.suffix in {'.py','.mjs','.png','.md','.json'})

members = set()
for part, paths in parts.items():
    output = distribution / part
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in paths:
            name = 'CYBR-Forest/' + path.relative_to(root).as_posix()
            assert name not in members, f'Duplicate release member {name}'
            members.add(name)
            archive.write(path, name)
    assert output.stat().st_size < 25 * 1024**2, f'{part} exceeds the hosting file limit'
    with zipfile.ZipFile(output) as archive:
        assert archive.testzip() is None, f'{part} failed its CRC check'
        assert len(archive.namelist()) == len(paths)
    print(part, output.stat().st_size, 'bytes')
print('Verified',len(members),'release files')
