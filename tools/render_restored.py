#!/usr/bin/env python3
"""Rebuild, render and decode-check the restored 3D CYBR forest.

Uses the recovered native C++ camera/geometry renderer. Lighting caches are
explicitly approximations, and all their dependency files are hashed here.
No generated reference image or previous movie can be used as a render input.
"""
from __future__ import annotations
import argparse,datetime,hashlib,json,os,shutil,subprocess,sys,time
from pathlib import Path
from PIL import Image
from verify_restoration import verify
ROOT=Path(__file__).resolve().parents[1]

def digest(path:Path)->str:
    h=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(1<<20),b''):h.update(block)
    return h.hexdigest()

def run(args:list[str],log:Path,cwd:Path=ROOT)->None:
    print('RUN', ' '.join(str(v) for v in args),flush=True)
    with log.open('w') as f:
        p=subprocess.run([str(x) for x in args],cwd=cwd,stdout=f,stderr=subprocess.STDOUT)
    if p.returncode:
        raise RuntimeError(f"Command failed ({p.returncode}): {args}\n{log.read_text()[-6000:]}")

def probe(path:Path)->dict:
    p=subprocess.run(['ffprobe','-v','error','-count_frames','-select_streams','v:0',
       '-show_entries','stream=width,height,nb_read_frames,r_frame_rate:format=duration',
       '-of','json',str(path)],check=True,capture_output=True,text=True)
    return json.loads(p.stdout)

def main()->None:
    ap=argparse.ArgumentParser()
    ap.add_argument('--width',type=int,default=1920);ap.add_argument('--height',type=int,default=1080)
    ap.add_argument('--frames',type=int,default=72,help='Fresh frames per shot at 24 fps')
    ap.add_argument('--samples',type=int,default=4);ap.add_argument('--threads',type=int,default=4)
    ap.add_argument('--first',type=int,default=0);ap.add_argument('--last',type=int,default=1)
    ap.add_argument('--cache-min',type=int,default=256);ap.add_argument('--cache-max',type=int,default=1024)
    ap.add_argument('--reuse-build',action='store_true');ap.add_argument('--force-cache',action='store_true')
    a=ap.parse_args()
    if not(0<=a.first<=a.last<=11) or min(a.width,a.height,a.frames,a.samples,a.threads)<2:
        ap.error('Invalid range, dimensions or sample count')
    if a.width%2 or a.height%2:ap.error('H.264 output requires even dimensions')
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):raise RuntimeError('FFmpeg and FFprobe are required')
    logs=ROOT/'logs';logs.mkdir(exist_ok=True);assets=ROOT/'assets';delivery=ROOT/'delivery';delivery.mkdir(exist_ok=True)
    def status(stage,**extra):
        (logs/'delivery_status.json').write_text(json.dumps({'stage':stage,'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),**extra},indent=2))
    status('build')
    if not a.reuse_build:
        run(['cmake','-S','.', '-B','build','-DCMAKE_BUILD_TYPE=Release'],logs/'configure_reproduction.log')
        run(['cmake','--build','build','--config','Release','--parallel',str(a.threads)],logs/'build_reproduction.log')
    exe=ROOT/'build/cybr-film'
    if os.name=='nt':
        exe=ROOT/'build/Release/cybr-film.exe'
        if not exe.is_file():exe=ROOT/'build/cybr-film.exe'
    if not exe.is_file():raise FileNotFoundError(exe)
    run(['ctest','--test-dir','build','-C','Release','--output-on-failure'],logs/'ctest_delivery.log')
    if not(assets/'forest.cys').is_file():
        run([sys.executable,ROOT/'tools/restore_original.py'],logs/'restore_reproduction.log')
    verify()
    inputs=[assets/'forest.cys',assets/'bark.tex',assets/'soil.tex',ROOT/'src/prepare_scene.py',ROOT/'tools/restore_original.py']
    inputs+=sorted((ROOT/'src').glob('*.cpp'))+sorted((ROOT/'src').glob('*.hpp'))
    dependencies={str(p.relative_to(ROOT)):digest(p) for p in inputs}
    profile={'first':a.first,'last':a.last,'camera_steps':8,'cell_m':1,'cache_min':a.cache_min,'cache_max':a.cache_max,'target':.04}
    deps={'dependencies':dependencies,'profile':profile}
    deps_path=assets/'lighting_dependencies.json'
    rebuild=a.force_cache or not deps_path.is_file()
    if not rebuild:
        try:
            old=json.loads(deps_path.read_text());rebuild=old.get('dependencies')!=dependencies or old.get('profile')!=profile
            rebuild |= any(not(assets/n).is_file() or digest(assets/n)!=old.get('cache_sha256',{}).get(n) for n in ['forest.irr','forest.vol'])
        except (ValueError,OSError):rebuild=True
    def native(mode,more,log):
        run([exe,'--assets',assets,'--out',ROOT/'renders/frames','--threads',str(a.threads),'--mode',mode,*more],logs/log)
    if rebuild:
        status('gather')
        native('gather',['--first',str(a.first),'--last',str(a.last),'--camera-steps','8'],'gather_delivery.log')
        status('bake')
        native('bake',['--cache-min',str(a.cache_min),'--cache-max',str(a.cache_max),'--target','.04'],'bake_delivery.log')
        status('volume')
        native('volume',[],'volume_delivery.log')
        deps['cache_sha256']={n:digest(assets/n) for n in ['forest.irr','forest.vol']}
        deps_path.write_text(json.dumps(deps,indent=2))
    shots=['01_Threshold','02_Fern_level','03_Trunk_parallax','04_Into_the_light','05_Fern_close_pass','06_Under_the_crown','07_Cross_the_glade','08_Fallen_timber','09_Midstory_crane','10_Canopy_drift','11_Overhead','12_Last_light']
    clips=[];records=[]
    for shot in range(a.first,a.last+1):
        status('rendering',shot=shot,shot_name=shots[shot],frames=a.frames)
        native('film',['--width',str(a.width),'--height',str(a.height),'--samples',str(a.samples),
          '--frames',str(a.frames),'--first',str(shot),'--last',str(shot)],f'shot_{shot:02d}.log')
        directory=ROOT/'renders/frames'/shots[shot];frameinfo=[]
        for frame in range(a.frames):
            p=directory/f'{frame:05}.ppm';rp=p.with_suffix('.json')
            report=json.loads(rp.read_text())
            with Image.open(p) as im:
                if im.size!=(a.width,a.height):raise ValueError('Wrong native frame size')
                im.load()
                if frame in [0,a.frames//2,a.frames-1]:im.save(delivery/f'{shots[shot]}_{frame:05}.png')
            if report.get('nonfinite_samples',0)!=0:raise ValueError('Nonfinite render samples')
            frameinfo.append({'frame':frame,'sha256':digest(p),'renderer_report':report})
        if len({x['sha256'] for x in frameinfo})!=a.frames:raise ValueError('Duplicate render frames')
        mp4=delivery/f'{shots[shot]}.mp4'
        status('encoding',shot=shot)
        run(['ffmpeg','-y','-v','error','-framerate','24','-start_number','0','-i',directory/'%05d.ppm',
             '-frames:v',str(a.frames),'-c:v','libx264','-preset','medium','-crf','17',
             '-pix_fmt','yuv420p','-movflags','+faststart',mp4],logs/f'encode_{shot:02d}.log')
        meta=probe(mp4);s=meta['streams'][0]
        if int(s['nb_read_frames'])!=a.frames or (s['width'],s['height'])!=(a.width,a.height):raise ValueError('Encoded metadata mismatch')
        run(['ffmpeg','-v','error','-i',mp4,'-f','null','-'],logs/f'decode_{shot:02d}.log')
        clips.append(mp4);records.append({'name':shots[shot],'file':mp4.name,'metadata':meta,'frame_reports':frameinfo,'sha256':digest(mp4)})
    listing=delivery/'concat.txt';listing.write_text(''.join("file '"+p.name+"'\n" for p in clips))
    movie=delivery/'CYBR_FOREST_3D_RESTORED.mp4'
    run(['ffmpeg','-y','-v','error','-f','concat','-safe','0','-i',listing,'-c','copy','-movflags','+faststart',movie],logs/'concat.log')
    run(['ffmpeg','-v','error','-i',movie,'-f','null','-'],logs/'decode_movie.log')
    movie_meta=probe(movie);expected=a.frames*len(clips)
    if int(movie_meta['streams'][0]['nb_read_frames'])!=expected:raise ValueError('Combined movie frame mismatch')
    result={'schema':'cybr-restored-film-v1','freshly_rendered':True,'complete':True,
      'backend':'Recovered native C++ renderer; ray-traced visibility, path-traced diffuse cache, approximate volumetrics, temporal AA',
      'geometry_source':'Original CYBR_FOREST.glb','geometry_sha256':digest(assets/'input/CYBR_FOREST.glb'),
      'width':a.width,'height':a.height,'fps':24,'frame_count':expected,'shots':records,
      'camera_samples_per_pixel':a.samples,'image_generation_used':False,'billboard_substitution':False,
      'static_geometry':True,'full_convergence_established':False,'baked_lighting':json.loads((assets/'forest.irr.json').read_text()),
      'full_decode_passed':True,'movie_metadata':movie_meta,'movie_sha256':digest(movie),
      'dependencies':deps,'purpose':'Restore the accepted 3D asset baseline; not a completed AAA upgrade'}
    (delivery/'validation.json').write_text(json.dumps(result,indent=2))
    status('complete',movie=str(movie),frame_count=expected)
    print('COMPLETE',movie,flush=True)
if __name__=='__main__':
    try:main()
    except Exception as e:
        (ROOT/'logs/delivery_status.json').write_text(json.dumps({'stage':'failed','error':str(e)},indent=2));raise
