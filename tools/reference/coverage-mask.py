"""Replay production visibility into a material coverage matte for the numeric comparison."""
import json,os,shutil,subprocess,sys
from pathlib import Path
capture=Path(sys.argv[1]);output=Path(sys.argv[2]);commands=json.loads((capture/'commands.json').read_text())
mode=sys.argv[3] if len(sys.argv)>3 else 'tree'
folder=capture.parent/(capture.name+'-'+mode);folder.mkdir(exist_ok=True)
for p in capture.glob('*.bin'):
    dst=folder/p.name
    if not dst.exists():os.link(p,dst)
for c in commands['commands']:
    if c['name']!='shaderSource':continue
    source=c['args'][1]
    if 'vec4(tonemap(color),coverage)' in source:
        if mode=='background':
            c['args'][1]=source.replace('vec4(tonemap(color),coverage);','vec4(tonemap(color),coverage);if(vExtra.x>.5)discard;')
        else:
            foliage='(vExtra.x>2.5 && vExtra.x<4.5)||vExtra.x>6.5' if mode=='meadow' else 'vExtra.x>4.5 && vExtra.x<6.5'
            c['args'][1]=source.replace('vec4(tonemap(color),coverage)',f'vec4(float({foliage}),float(vExtra.x>.5 && vExtra.x<1.5),shadow,coverage)')
    elif 'vec4(tonemap(lit),sampleCoverage)' in source:c['args'][1]=source.replace('vec4(tonemap(lit),sampleCoverage)','vec4(0.,0.,0.,sampleCoverage)')
    elif mode!='background' and 'uniform sampler2D uPhotographicSky;' in source:c['args'][1]=source.replace('void main(){','void main(){outColor=vec4(0.,0.,0.,1.);return;')
(folder/'commands.json').write_text(json.dumps(commands,separators=(',',':')))
subprocess.run(['python',Path(__file__).resolve().parents[1]/'qa/gles-replay.py',folder],env={**os.environ,'LP_NUM_THREADS':'2'},check=True)
shutil.copyfile(folder/'fallback-meadow.png',output)
