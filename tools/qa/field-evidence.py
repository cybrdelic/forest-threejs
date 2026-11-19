"""Reproduce the native 1080p field views and their screen-space reference crop.

Run 'python tools/qa/field-evidence.py --help' for inputs. The same WebGL
application commands drive both the native-resolution and supersampled image.
These captures measure raster behavior on a software adapter, not hardware fps.
"""
import argparse
import fcntl
from hashlib import sha256
import json
import os
from pathlib import Path
import subprocess
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont

CHECKOUT = Path(__file__).resolve().parents[2]
SIZE = (1920, 1080)
# Left, top, width, height in a full 1920 x 1080 image.
CROP = (512, 490, 896, 542)
WIND_CROP = (900, 810, 256, 160)
SHOTS = {
    'meadow': ('meadow', {'TEST_SUN_AZIMUTH':345,'TEST_SUN_ELEVATION':48}),
    'front': ('meadow', {'TEST_SUN_AZIMUTH': 103, 'TEST_SUN_ELEVATION': 38}),
    'back': ('meadow', {'TEST_SUN_AZIMUTH': 283, 'TEST_SUN_ELEVATION': 38}),
    'shade': ('forest', {'TEST_SUN_AZIMUTH':345,'TEST_SUN_ELEVATION':48}),
    'botany': ('botany', {'TEST_SUN_AZIMUTH':345,'TEST_SUN_ELEVATION':48}),
}


def read_json(filename):
    return json.loads(filename.read_text())


def digest(filename):
    return sha256(filename.read_bytes()).hexdigest()


def display_to_linear(values):
    return np.where(values <= .04045, values / 12.92, ((values + .055) / 1.055) ** 2.4)


def linear_to_display(values):
    return np.where(values <= .0031308, values * 12.92, 1.055 * values ** (1 / 2.4) - .055)


def capture(args):
    name = args.shot
    stage = args.stage
    scene, overrides = SHOTS[name]
    output = args.work / (name + ('-' + stage if stage != 'still' else ''))
    output.mkdir(parents=True, exist_ok=True)
    scale = 2 if stage in ['reference','wind-reference'] else 1
    env = {
        **os.environ,
        **{key: str(value) for key, value in overrides.items()},
        'TEST_WIDTH': str(SIZE[0] * scale),
        'TEST_HEIGHT': str(SIZE[1] * scale),
        'TEST_MSAA': '4',
        'TEST_TIME': '1',
        'TEST_WIND': '0.8',
        'TEST_FRAMES': str(args.frames if stage in ['walk','wind-reference'] else 1),
        'TEST_TRAVEL': '0.25',
        'TEST_FORWARD': '0.85',
        'TEST_PAN': '1.1',
        'TEST_FPS': str(args.fps),
        'FOREST_GLES_OUTPUT': str(output),
        'LP_NUM_THREADS': str(args.threads),
        # Limit driver command queues during dense vegetation raster on llvmpipe.
        'TEST_FLUSH_INDICES': '650000',
    }
    if stage in ['reference','wind-reference']:
        crop = WIND_CROP if stage == 'wind-reference' else CROP
        env['TEST_CROP'] = ','.join(str(value * scale) for value in crop)
    if stage == 'wind-reference':
        env['TEST_FRAME_LIMIT'] = '2'
    record = args.source / 'tools/qa/gles-record.mjs'
    replay = CHECKOUT / 'tools/qa/gles-replay.py'
    if not args.replay_only:
        with (output / 'record.log').open('w') as logfile:
            subprocess.run(['node', record, scene], env=env, stdout=logfile, stderr=subprocess.STDOUT, check=True)
    with (output / 'replay.log').open('w') as logfile:
        subprocess.run([sys.executable, replay, output], env=env, stdout=logfile, stderr=subprocess.STDOUT, check=True)
    print(output,flush=True)


def compare_crop(native, reference, crop=CROP):
    x,y,w,h = crop
    original = np.asarray(Image.open(native).convert('RGB'), dtype=np.float64)[y:y+h,x:x+w] / 255
    grid = np.asarray(Image.open(reference).convert('RGB'), dtype=np.float64) / 255
    if grid.shape != (h * 2, w * 2, 3):
        raise ValueError('Reference does not cover the specified double-resolution region')
    reduced = linear_to_display(display_to_linear(grid).reshape(h, 2, w, 2, 3).mean(axis=(1, 3)))
    luma = np.array([.2126, .7152, .0722])
    original_y = original @ luma * 255
    reference_y = reduced @ luma * 255
    sections = {}
    for region, rows in [('whole',slice(None)), ('upper',slice(0,h//2)), ('lower',slice(h//2,None))]:
        a, b = original_y[rows], reference_y[rows]
        error = np.abs(a-b)
        sections[region] = {
            'pixels': int(error.size),
            'meanAbsoluteDisplayLumaDifference': round(error.mean(),3),
            'p95AbsoluteDisplayLumaDifference': round(np.percentile(error, 95),3),
            'nativeMeanHorizontalLumaGradient': round(np.abs(np.diff(a,axis=1)).mean(),3),
            'referenceMeanHorizontalLumaGradient': round(np.abs(np.diff(b,axis=1)).mean(),3),
        }
    return sections, Image.fromarray((reduced * 255).round().clip(0,255).astype(np.uint8))


def write_jpeg(im, target):
    im.convert('RGB').save(target, quality=94, optimize=True, subsampling=0)


def validate(record, dist):
    if record['errors'] or record['telemetry']['gpuErrors'] or record['samples'] != 4:
        raise ValueError('Failed native qualification')
    for filename, expected in {**record['sourceHashes'], **record['fetchedAssets']}.items():
        if digest(dist / filename) != expected:
            raise ValueError('Capture source has changed: ' + filename)


def publish(args):
    output = args.output
    output.mkdir(parents=True,exist_ok=True)
    def walk_directory(name):
        if name=='back' and args.corrected_back:return args.corrected_back
        return args.work/(name+'-walk')

    def render_source(name):
        if name=='back' and args.corrected_source:return args.corrected_source/'dist'
        return args.source/'dist'

    metadata = {'adapter':None,'api':None,'stills':{},'rasterReference':{},'walks':{}}
    for name, (scene, _) in SHOTS.items():
        directory = args.work/name
        if (directory/('result-'+scene+'.json')).is_file():
            frame = directory/('fallback-'+scene+'.png')
        else:
            directory = walk_directory(name)
            frame = directory/'frame-0000.png'
        record = read_json(directory/('result-'+scene+'.json'))
        validate(record, render_source(name))
        native = Image.open(frame)
        if native.size != SIZE: raise ValueError('Still dimensions: '+name)
        target = output/('meadow-1080.jpg' if name=='meadow' else 'meadow-'+name+'-1080.jpg')
        write_jpeg(native,target)
        metadata.update(adapter=record['adapter'],api=record['api'])
        if name=='meadow':
            metadata['captureSourceSHA256'] = record['sourceHashes']
            metadata['assetSHA256'] = record['fetchedAssets']
        metadata['stills'][name] = {
            'file':target.name,'sha256':digest(target),'size':list(native.size),
            'msaa':record['samples'],'triangles':record['frames'][0]['triangles'],
            'settings':record['settings'],'camera':record['frames'][0]['camera'],
            'yaw':record['frames'][0]['yaw'],'pitch':record['frames'][0]['pitch'],
            'time':record['startTime'],
        }
    high_dir = args.work/'meadow-reference'
    rec = read_json(high_dir/'result-meadow.json')
    validate(rec, args.source/'dist')
    native_file = args.work/'meadow/fallback-meadow.png'
    scores, reference = compare_crop(native_file,high_dir/'fallback-meadow.png')
    x,y,w,h = CROP
    native = Image.open(native_file).convert('RGB').crop((x,y,x+w,y+h))
    plate = Image.new('RGB',(w*2,h+42),(20,23,21))
    font = ImageFont.truetype('DejaVuSans.ttf',21)
    draw = ImageDraw.Draw(plate)
    for i, (im, label) in enumerate([(native,'Native 1080p · 4× MSAA'),(reference,'2× each axis · 4× MSAA · area reduced')]):
        plate.paste(im,(i*w,42))
        draw.text((i*w+12,9),label,font=font,fill='white')
    target = output/'raster-detail-comparison.jpg'
    write_jpeg(plate,target)
    metadata['rasterReference'] = {
        'file':target.name,'sha256':digest(target),'fullSize':[3840,2160],'cropIn1080Pixels':list(CROP),
        'comparison':'Matched camera, geometry, wind, time, sun and 4× sample coverage. Only the final viewport resolution doubles. The cropped region is reduced in linear display light. Luma errors are measured before JPEG compression on a 0–255 display scale.',
        'regions':scores,
    }
    if args.baseline_work:
        baseline_dir = args.baseline_work
        baseline = baseline_dir/'baseline/fallback-meadow.png'
        baseline_reference = baseline_dir/'baseline-2x/fallback-meadow.png'
        old_scores,_ = compare_crop(baseline,baseline_reference)
        before = Image.open(baseline).convert('RGB')
        after = Image.open(native_file).convert('RGB')
        if before.size != after.size: raise ValueError('Before and after resolution differs')
        plate = Image.new('RGB',(1920,584),(20,23,21))
        draw = ImageDraw.Draw(plate)
        for i, (im, label) in enumerate([(before,'Previous release'),(after,'Updated scene')]):
            plate.paste(im.resize((960,540),Image.Resampling.LANCZOS),(i*960,44))
            draw.text((i*960+14,11),label,font=font,fill='white')
        target = output/'meadow-before-after.jpg'
        write_jpeg(plate,target)
        metadata['beforeAfter'] = {
            'file':target.name,'sha256':digest(target),
            'baselineCommit':'6976a150a0cf82c7d71b33d82013f880f83a928e',
            'sourceResolution':[1920,1080],'settings':'Initial meadow camera, matched 345° azimuth and 48° solar elevation, wind 0.8, 90,000 trees, balanced quality, scene time 1 s, 4× MSAA',
            'baselineRasterReference':old_scores,
            'note':'Each release is compared to its own supersampled output. Scene geometry, lighting and frequency content differ.'
        }
    videos = []
    for name, (scene, _) in SHOTS.items():
        directory = walk_directory(name)
        result = directory/('result-'+scene+'.json')
        if not result.exists(): continue
        record = read_json(result)
        validate(record,render_source(name))
        if record['width']!=1920 or record['height']!=1080: raise ValueError('Walk dimensions')
        if record['frames'][0]['camera'] == record['frames'][-1]['camera']: raise ValueError('Static walk')
        frames = sorted(directory.glob('frame-*.png'))
        if len(frames) != len(record['frames']) or len({digest(path) for path in frames}) != len(frames):
            raise ValueError('Walk sequence contains a missing or repeated capture')
        target = args.work/('walk-'+name+'.mp4')
        subprocess.run(['ffmpeg','-v','error','-y','-framerate',str(record['frameRate']),'-i',str(directory/'frame-%04d.png'),
                        '-frames:v',str(len(frames)),'-vf','scale=out_color_matrix=bt709,format=yuv420p','-c:v','libx264',
                        '-preset','medium','-crf','17','-colorspace','bt709','-color_trc','iec61966-2-1','-color_primaries','bt709','-color_range','tv',
                        '-threads','2','-movflags','+faststart',str(target)],check=True)
        videos.append(target)
        metadata['walks'][name]={'frames':len(frames),'size':[1920,1080],'fps':record['frameRate'],'timeStart':record['startTime'],
                                 'settings':record['settings'],'poses':[{key:frame[key] for key in ['seconds','camera','yaw','pitch']} for frame in record['frames']]}
    for name, (scene, _) in SHOTS.items():
        directory = args.work/(name+'-wind-reference')
        result = directory/('result-'+scene+'.json')
        if not result.exists():continue
        ref_record = read_json(result)
        validate(ref_record,args.source/'dist')
        native_dir = args.work/(name+'-walk')
        native_record=read_json(native_dir/('result-'+scene+'.json'))
        assert ref_record['settings']==native_record['settings'] and ref_record['startTime']==native_record['startTime']
        x,y,w,h=WIND_CROP
        luma=np.array([.2126,.7152,.0722])
        differences=[]
        native_luma=[]
        reference_luma=[]
        stats=[]
        plate=Image.new('RGB',(w*2,h*2+72),(20,23,21))
        draw=ImageDraw.Draw(plate)
        for index in range(2):
            pose=ref_record['frames'][index]
            if any(pose[key]!=native_record['frames'][index][key] for key in ['seconds','camera','yaw','pitch']):
                raise ValueError('Wind reference pose mismatch')
            native_file=native_dir/('frame-%04d.png'%index)
            ref_file=directory/('frame-%04d.png'%index)
            values,reduced=compare_crop(native_file,ref_file,WIND_CROP)
            native=Image.open(native_file).convert('RGB').crop((x,y,x+w,y+h))
            grid=np.asarray(Image.open(ref_file).convert('RGB'),dtype=np.float64)/255
            reference=linear_to_display(display_to_linear(grid).reshape(h,2,w,2,3).mean(axis=(1,3))) * 255
            native_luma.append(np.asarray(native,dtype=float) @ luma)
            reference_luma.append(reference @ luma)
            differences.append(native_luma[-1]-reference_luma[-1])
            y0=index*(h+36)
            plate.paste(native,(0,y0+36));plate.paste(reduced,(w,y0+36))
            draw.text((7,y0+7),'Native · pose '+str(index+1),font=font,fill='white')
            draw.text((w+7,y0+7),'2× reference · pose '+str(index+1),font=font,fill='white')
            stats.append(values['whole'])
        temporal=np.abs(differences[1]-differences[0])
        native_delta=native_luma[1]-native_luma[0]
        reference_delta=reference_luma[1]-reference_luma[0]
        target=output/('wind-detail-'+name+'.jpg')
        write_jpeg(plate,target)
        metadata.setdefault('movingRasterReference',{})[name]={
            'file':target.name,'sha256':digest(target),'nativeSize':list(SIZE),'referenceSize':[3840,2160],
            'cropIn1080Pixels':list(WIND_CROP),'regions':stats,'samples':4,'frames':2,
            'secondsBetweenPoses':ref_record['frames'][1]['seconds']-ref_record['frames'][0]['seconds'],
            'frameChangeResidual':{'meanAbsoluteDisplayLuma':float(temporal.mean()),'p95':float(np.percentile(temporal,95)),
                                   'fractionAbove8':float((temporal>8).mean()),
                                   'nativeMeanAbsoluteChange':float(np.abs(native_delta).mean()),
                                   'referenceMeanAbsoluteChange':float(np.abs(reference_delta).mean()),
                                   'signedChangeCorrelation':float(np.corrcoef(native_delta.ravel(),reference_delta.ravel())[0,1])},
            'method':'The camera translates, yaws, follows terrain height, and wind animation advances. Each native frame is compared to the same pose, sun, wind, and time rendered at double width and height. The residual compares the signed native frame change to the signed change in the area-filtered references at corresponding screen coordinates.'
        }
    if videos:
        # Generate a concat list relative to a controlled directory.
        concat = args.work/'walk-list.txt'
        concat.write_text(''.join("file '"+str(v.relative_to(args.work))+"'\n" for v in videos))
        target=output/'meadow-motion.mp4'
        subprocess.run(['ffmpeg','-v','error','-y','-f','concat','-safe','1','-i',str(concat),
                        '-c','copy','-movflags','+faststart',str(target)],check=True)
        probe = json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-count_frames','-show_entries',
                                                  'stream=width,height,duration,nb_read_frames','-of','json',str(target)]))['streams'][0]
        if int(probe['nb_read_frames']) != sum(w['frames'] for w in metadata['walks'].values()):
            raise ValueError('Encoded frame count differs from rendered frames')
        checksums=subprocess.check_output(['ffmpeg','-v','error','-i',str(target),'-map','0:v:0','-f','framemd5','-'],text=True)
        decoded=[line.rsplit(',',1)[-1].strip() for line in checksums.splitlines() if line and not line.startswith('#')]
        if len(set(decoded)) != int(probe['nb_read_frames']):raise ValueError('Encoded duplicate video frames')
        metadata['motionFile']={'file':target.name,'sha256':digest(target),'uniqueDecodedFrames':len(set(decoded)),**probe}
    if args.command_parity:
        metadata['openingCommandParity']={
            'method':'Recorded the scenes again from the final source, with explicit solar settings. Verified equal camera poses, times, settings, all fetched asset hashes and actual GLES calls. Independently initialized per-species atlas handles are normalized before comparing command streams. The order of draws and all draw arguments are preserved.',
            'results':read_json(args.command_parity)
        }
    if args.corrected_back:
        metadata['backlightCorrection']=read_json(args.corrected_back/'correction.json')
    metadata['limit']='Software-rasterized offline. Video cadence describes encoded playback. These captures do not measure interactive hardware performance.'
    (output/'field-verification.json').write_text(json.dumps(metadata,indent=2)+'\n')


def publish_primary(args):
    record = read_json(args.record)
    if record['errors'] or record['telemetry']['gpuErrors'] or [record['width'],record['height']] != list(SIZE):
        raise ValueError('WebGPU primary did not pass native 1080p qualification')
    if record['frameCount']<2 or record['frameCameras'][0]['position']==record['frameCameras'][-1]['position']:
        raise ValueError('WebGPU primary lacks a second moving-camera frame')
    for name, expected in {**record['sourceHashes'],**record['fetchedAssets']}.items():
        if digest(args.source/'dist'/name) != expected:raise ValueError('WebGPU source mismatch: '+name)
    output=args.output
    output.mkdir(parents=True,exist_ok=True)
    target=output/'webgpu-meadow.jpg'
    write_jpeg(Image.open(args.record.with_suffix('.png')),target)
    info={'file':target.name,'sha256':digest(target),'width':record['width'],'height':record['height'],
          'frameCount':record['frameCount'],'poses':record['frameCameras'],'wind':record['wind'],
          'deltaTimeSeconds':record['deltaTime'],'solarElevation':record['sunElevation'],'solarAzimuth':record['sunAzimuth'],
          'density':record['density'],'quality':record['quality'],'adapter':record['telemetry']['adapter'],
          'rasterSamples':record['telemetry']['rasterSamples'],'visibleTriangles':record['telemetry']['triangles'],
          'initializationMilliseconds':record['initializationMilliseconds'],'softwareFrameMilliseconds':record['renderTimes'],
          'errors':record['errors'],'captureSourceSHA256':record['sourceHashes'],
          'note':'Production WebGPU backend on native Dawn with software Vulkan. Two consecutive frames use wind and terrain-following camera translation. The image is the final resolved frame. Software timings do not measure interactive desktop or mobile performance.'}
    (output/'webgpu-verification.json').write_text(json.dumps(info,indent=2)+'\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work',type=Path,required=True,help='Absolute scratch directory for recorded command buffers and captures')
    parser.add_argument('--source',type=Path,default=CHECKOUT,help='Optional frozen checkout for capture/verification')
    sub = parser.add_subparsers(dest='operation',required=True)
    cap = sub.add_parser('capture')
    cap.add_argument('shot',choices=SHOTS)
    cap.add_argument('stage',choices=['still','walk','reference','wind-reference'])
    cap.add_argument('--frames',type=int,default=16)
    cap.add_argument('--fps',type=int,default=24)
    cap.add_argument('--threads',type=int,default=4)
    cap.add_argument('--replay-only',action='store_true')
    pub = sub.add_parser('publish')
    pub.add_argument('--output',type=Path,required=True,help='Evidence directory')
    pub.add_argument('--baseline-work',type=Path,help='V8 capture root with baseline and baseline-2x subdirectories')
    pub.add_argument('--command-parity',type=Path,help='Optional verified gles-parity.py aggregation for the final source')
    pub.add_argument('--corrected-back',type=Path,help='Corrected, verified backlight frame directory')
    pub.add_argument('--corrected-source',type=Path,help='Frozen source for the backlight correction')
    gpu = sub.add_parser('primary')
    gpu.add_argument('--record',required=True,type=Path,help='Native webgpu.mjs JSON record and adjacent PNG')
    gpu.add_argument('--output',required=True,type=Path)
    args = parser.parse_args()
    if args.operation=='capture':
        args.work.mkdir(parents=True,exist_ok=True)
        with (args.work/'.native-capture.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            capture(args)
    elif args.operation=='primary':
        publish_primary(args)
    else:
        publish(args)
