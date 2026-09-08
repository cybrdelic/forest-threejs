#!/usr/bin/env python3
"""Render verified native camera sequences. Never accepts prior movies as inputs."""
from __future__ import annotations
import argparse,datetime,hashlib,json,subprocess
from pathlib import Path
from PIL import Image,ImageDraw
ROOT=Path(__file__).resolve().parents[1]
NAMES=['01_Threshold','02_Fern_level','03_Trunk_parallax','04_Into_the_light','05_Fern_close_pass','06_Under_the_crown','07_Cross_the_glade','08_Fallen_timber','09_Midstory_crane','10_Canopy_drift','11_Overhead','12_Last_light']
def digest(p):
    h=hashlib.sha256()
    with Path(p).open('rb') as f:
        for b in iter(lambda:f.read(1<<20),b''):h.update(b)
    return h.hexdigest()
def probe(path):
    return json.loads(subprocess.run(['ffprobe','-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=width,height,nb_read_frames,r_frame_rate:format=duration','-of','json',str(path)],capture_output=True,text=True,check=True).stdout)
def run(args,log):
    with log.open('w') as f:
        p=subprocess.run(list(map(str,args)),stdout=f,stderr=subprocess.STDOUT,cwd=ROOT)
    if p.returncode:raise RuntimeError(str(log)+'\n'+log.read_text()[-2000:])
def render(label,width,height,shots,frames,spp):
    work=ROOT/'renders'/label;out=ROOT/'delivery'/label;out.mkdir(parents=True,exist_ok=True)
    exe=ROOT/'build/cybr-film';clips=[];reports=[];thumbs=[]
    source_files=sorted((ROOT/'src').glob('*.cpp'))+sorted((ROOT/'src').glob('*.hpp'))
    snapshot={'files':{str(p.relative_to(ROOT)):digest(p) for p in source_files},'executable_sha256':digest(exe),'scene_sha256':digest(ROOT/'assets/forest.cys'),'bark_sha256':digest(ROOT/'assets/bark.tex'),'soil_sha256':digest(ROOT/'assets/soil.tex'),'irradiance_sha256':digest(ROOT/'assets/forest.irr'),'volume_sha256':digest(ROOT/'assets/forest.vol')}
    for shot in shots:
        status={'stage':'rendering','label':label,'shot':shot,'requested_shots':shots,'frames_per_shot':frames,'complete':False}
        (ROOT/'reports/quality-delivery-status.json').write_text(json.dumps(status,indent=2))
        args=[exe,'--assets',ROOT/'assets','--out',work,'--mode','film','--width',width,'--height',height,'--samples',spp,'--frames',frames,'--first',shot,'--last',shot,'--wind',.75,'--threads',4,'--no-temporal','--resume']
        run(args,ROOT/'reports'/f'{label}_{shot:02}.log')
        directory=work/NAMES[shot];frame_data=[]
        for f in range(frames):
            p=directory/f'{f:05}.ppm';j=p.with_suffix('.json');r=json.loads(j.read_text())
            if not(p.is_file() and r['width']==width and r['height']==height and r['frame']==f and r['shot']==shot and r['nonfinite_samples']==0 and r['geometry_animated'] and r['camera_animated']):raise RuntimeError('Frame verification failed')
            frame_data.append({'frame':f,'sha256':digest(p),'report':r})
        if len(set(x['sha256'] for x in frame_data))!=frames:raise RuntimeError('Duplicate rendered frames')
        clip=out/(NAMES[shot]+'.mp4')
        run(['ffmpeg','-y','-v','error','-threads','2','-framerate','24','-i',directory/'%05d.ppm','-frames:v',frames,'-c:v','libx264','-threads','2','-preset','slow','-crf','17','-pix_fmt','yuv420p','-movflags','+faststart',clip],ROOT/'reports'/f'{label}_{shot:02}_encode.log')
        m=probe(clip);s=m['streams'][0]
        if s['width']!=width or s['height']!=height or int(s['nb_read_frames'])!=frames or s['r_frame_rate']!='24/1':raise RuntimeError('Encoded metadata mismatch')
        run(['ffmpeg','-v','error','-threads','2','-i',clip,'-f','null','-'],ROOT/'reports'/f'{label}_{shot:02}_decode.log')
        gif=out/(NAMES[shot]+'.gif')
        run(['ffmpeg','-y','-v','error','-i',clip,'-vf','fps=10,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=3','-loop','0',gif],ROOT/'reports'/f'{label}_{shot:02}_gif.log')
        image=Image.open(directory/f'{frames//2:05}.ppm');image.save(out/(NAMES[shot]+'.png'));thumbs.append((NAMES[shot],image.copy()))
        reports.append({'shot':shot,'name':NAMES[shot],'mp4':clip.name,'mp4_sha256':digest(clip),'gif_sha256':digest(gif),'metadata':m,'frames':frame_data});clips.append(clip)
    concat=out/'concat.txt';concat.write_text('\n'.join("file '"+str(p.resolve())+"'" for p in clips)+'\n')
    film=out/'CYBR_FOREST_Quality_Film.mp4'
    run(['ffmpeg','-y','-v','error','-f','concat','-safe','0','-i',concat,'-c','copy','-movflags','+faststart',film],ROOT/'reports'/f'{label}_assemble.log')
    meta=probe(film)
    if int(meta['streams'][0]['nb_read_frames'])!=frames*len(shots):raise RuntimeError('Film count mismatch')
    run(['ffmpeg','-v','error','-threads','2','-i',film,'-f','null','-'],ROOT/'reports'/f'{label}_decode.log')
    cols=2 if len(shots)<=4 else 3;rows=(len(shots)+cols-1)//cols;sheet=Image.new('RGB',(cols*480,rows*294))
    for i,(name,im) in enumerate(thumbs):
        tile=Image.new('RGB',(480,294));tile.paste(im.resize((480,270)));ImageDraw.Draw(tile).text((8,276),name,fill='white');sheet.paste(tile,(i%cols*480,i//cols*294))
    sheet.save(out/'shots.jpg',quality=93)
    report={'schema':'cybr-quality-film-v1','complete':True,'freshly_rendered':True,'image_generation_used':False,'full_decode_passed':True,'native_dimensions':[width,height],'fps':24,'frames':frames*len(shots),'shot_count':len(shots),'samples_per_pixel':spp,'full_convergence_certified':False,'transport':'Native C++ primary geometry and direct visibility, 128-512 path-sample diffuse lighting records, frozen-rest-pose indirect cache and approximate volume field. 0.75-strength geometric wind. No temporal filtering, no image synthesis, no shutter integration.','source_snapshot':snapshot,'film_sha256':digest(film),'film_metadata':meta,'shots':reports}
    (out/'validation.json').write_text(json.dumps(report,indent=2)+'\n')
    (ROOT/'reports/quality-delivery-status.json').write_text(json.dumps({'stage':'complete','label':label,'film':str(film),'complete':True,'fully_converged':False},indent=2))
    print('COMPLETE',label,film,flush=True)
    return report
if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--profile',choices=['proof','film','both'],default='both');a=ap.parse_args()
    if a.profile in ('proof','both'):render('proof1080',1920,1080,[0,2],48,4)
    if a.profile in ('film','both'):render('film720',1280,720,list(range(12)),48,4)
