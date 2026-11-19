"""Compare GLES recordings after canonicalizing independent impostor setup.

The two source tree atlases load concurrently. Each setup creates its own
program, textures, VAO and uniforms. Their completion order can exchange GL
handle numbers. The comparison keeps every draw, buffer payload, argument
and shader source, and consistently renumbers references after sorting those
two resource-only setup blocks. Draw order is never sorted.
"""
import argparse
import hashlib
import json
from pathlib import Path


def canonical(commands):
    groups = []
    for i,command in enumerate(commands):
        if command['name'] != 'createProgram' or i + 2 >= len(commands):
            continue
        shader = commands[i+2]
        if shader['name'] != 'shaderSource' or 'gl_VertexID' not in shader['args'][1] or 'aVariation' not in shader['args'][1]:
            continue
        end = i+1
        while end < len(commands):
            last = commands[end]
            if last['name'].startswith('draw'):
                raise ValueError('Draw encountered inside independent resource setup')
            end += 1
            if last['name']=='getUniformLocation' and last['args'][1]=='uSurfaceDFG':
                break
        groups.append((i,end,shader['args'][1]))
    if len(groups) != 2 or groups[0][1] != groups[1][0]:
        raise ValueError('Could not isolate adjacent per-species impostor setup blocks')
    chunks = [commands[a:b] for a,b,key in sorted(groups,key=lambda group: group[2])]
    stream = commands[:groups[0][0]] + chunks[0] + chunks[1] + commands[groups[1][1]:]
    remap = {}
    out = []
    for cmd in stream:
        entry = {'name':cmd['name'],'args':[{'ref':remap[v['ref']]} if isinstance(v,dict) and 'ref' in v else v for v in cmd['args']]}
        if 'id' in cmd:
            entry['id'] = len(remap)+1
            remap[cmd['id']] = entry['id']
        out.append(entry)
    return out


def compare(a,b):
    for key in ['settings','frames','startTime','width','height','requestedSamples','fetchedAssets']:
        if a[key] != b[key]:raise ValueError('Application capture states differ in '+key)
    left = canonical(a['commands'])
    if left != canonical(b['commands']):raise ValueError('GLES commands differ')
    data=json.dumps(left,separators=(',',':')).encode()
    return {'frames':len(a['frames']),'commands':len(left),'sha256CanonicalCommands':hashlib.sha256(data).hexdigest(),
            'matchedRawHandleOrder':a['commands']==b['commands']}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('before',type=Path)
    parser.add_argument('after',type=Path)
    args=parser.parse_args()
    print(json.dumps(compare(json.loads(args.before.read_text()),json.loads(args.after.read_text())),indent=2))
