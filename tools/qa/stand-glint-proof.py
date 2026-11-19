"""Replay a recorded canopy draw with the original or revised release shader.
Keep the original camera, uniform/texture uploads, sample positions, dynamic
draws and LOD selections. In isolated mode suppress every color draw except
the aggregate stand; terrain and foreground thus cannot conceal a trigger.
"""
import argparse,json,os,subprocess
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('record',type=Path);p.add_argument('output',type=Path)
p.add_argument('--revised-record',type=Path,help='Capture recorded from the exact release source; its compiled GLSL is substituted into the input trace.')
p.add_argument('--mode',choices=['beauty','fresnel','components'],default='beauty')
p.add_argument('--frame',type=int,help='Replay through this frame and capture this frame only.')
p.add_argument('--full-scene',action='store_true')
p.add_argument('--crop',help='left,top,width,height in original viewport pixels')
args=p.parse_args()
args.output.mkdir(exist_ok=True,parents=True)
def load(folder):return json.loads((folder/'commands.json').read_text())
record=load(args.record)
def geometry_shader(cmd):return cmd['name']=='shaderSource' and 'vec3 view=normalize(uCamera-vPosition);' in cmd['args'][1]
revised=None
if args.revised_record:
    revised=next(c['args'][1] for c in load(args.revised_record)['commands'] if geometry_shader(c))
for filename in args.record.glob('*.bin'):
    dest=args.output/filename.name
    if not dest.exists():os.link(filename,dest)
if args.frame is not None:
    frame=record['frames'][args.frame];record['commands']=record['commands'][:frame['endCommand']];record['frames']=[frame]
ends={frame['endCommand']:frame for frame in record['frames']}
commands=[];aggregate=0
for i,c in enumerate(record['commands'],1):
    if geometry_shader(c):
        s=revised or c['args'][1]
        if args.mode!='beauty':
            prelude='''
            if(vExtra.x>1.9 && vExtra.x<2.1 && vExtra.y>=0.) {
                vec3 halfDir=normalize(view+uSun+vec3(.000001));
                float F=.04+.96*pow(1.-max(0.,dot(uSun,halfDir)),5.);
                RESULT
            }
            outColor=vec4(0.,0.,0.,1.);return;
            '''
            if args.mode=='fresnel':code='outColor=vec4(2.*F,float(F>.12),1.,1.);return;'
            else:
                call='surfaceDirectFiltered(vec3(0.),n,view,uSun,roughness,0.,1.,outerAperture)' if 'float outerAperture=' in s else 'surfaceDirect(vec3(0.),n,view,uSun,roughness,0.,1.)'
                code=f'''vec3 air=aerialPerspective(vec3(0.),vPosition,uCamera,uSun);
                vec3 wax={call}*shadow+surfaceEnvironment(reflectedSky,dot(n,view),roughness);
                vec3 waxTerm=aerialPerspective(wax,vPosition,uCamera,uSun)-air;
                vec3 bodyTerm=aerialPerspective(color-wax,vPosition,uCamera,uSun)-air;
                vec3 w=vec3(.2126,.7152,.0722);
                outColor=vec4(clamp(vec3(dot(bodyTerm,w),dot(waxTerm,w),dot(air,w)),0.,1.),1.);return;'''
            marker='  color = aerialPerspective(color,vPosition,uCamera,uSun);'
            assert marker in s;s=s.replace(marker,prelude.replace('RESULT',code)+marker)
        c['args'][1]=s
    is_draw=c['name'] in ('drawArrays','drawElements','drawElementsInstanced')
    # Identify the original indexed aggregate mesh by the exact frozen draw
    # size, then retain that draw only when isolating the stand.
    stand=c['name']=='drawElements' and c['args']==[4,2618406,5125,0]
    if stand:aggregate+=1
    if args.full_scene or not is_draw or stand:commands.append(c)
    if i in ends:ends[i]['endCommand']=len(commands)
assert aggregate>0, 'The registered aggregate draw no longer matches this source version.'
record['commands']=commands
(args.output/'commands.json').write_text(json.dumps(record,separators=(',',':')))
env={**os.environ,'LP_NUM_THREADS':os.getenv('LP_NUM_THREADS','1')}
if args.crop:env['TEST_CROP']=args.crop
subprocess.run(['python',Path(__file__).with_name('gles-replay.py'),args.output],env=env,check=True)
