"""Record, then replay the complete live WebGL program using the reference camera."""
import argparse,json,os,shutil,subprocess
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('output',type=Path)
p.add_argument('--site',type=Path,default=Path(__file__).resolve().parents[2])
p.add_argument('--tag',default='raster')
args=p.parse_args();scene=json.loads((args.output/'scene.json').read_text())
for label,azimuth in scene['views'].items():
    run_dir=args.output/(args.tag+'-'+label)
    env={**os.environ,'FOREST_GLES_OUTPUT':str(run_dir),'TEST_WIDTH':str(scene['width']),'TEST_HEIGHT':str(scene['height']),
         'TEST_WIND':'0','TEST_TRAVEL':'0','TEST_FORWARD':'0','TEST_CAMERA_POSITION':json.dumps(scene['position']),
         'TEST_CAMERA_TARGET':json.dumps(scene['target']),'TEST_SUN_ELEVATION':str(scene['sunElevation']),
         'TEST_SUN_AZIMUTH':str(azimuth),'TEST_TIME':'1','LP_NUM_THREADS':os.getenv('LP_NUM_THREADS','2')}
    subprocess.run(['node','tools/qa/gles-record.mjs'],env=env,cwd=args.site,check=True)
    subprocess.run(['python','tools/qa/gles-replay.py',run_dir],env=env,cwd=args.site,check=True)
    shutil.copyfile(run_dir/'fallback-meadow.png',args.output/(args.tag+'-'+label+'.png'))
