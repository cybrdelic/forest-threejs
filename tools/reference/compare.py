"""Compare release specimen radiance to Cycles, using only covered leaf pixels."""
import argparse,hashlib,json
from pathlib import Path
import numpy as np
from PIL import Image,ImageDraw,ImageFont

parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('captures',type=Path);parser.add_argument('output',type=Path)
parser.add_argument('--calibration',type=Path,help='Optional identical-geometry V8 calibration run (before, quarter, Cycles and matte)')
args=parser.parse_args();root=args.captures;out=args.output;out.mkdir(exist_ok=True,parents=True)
weights=np.array([.2126,.7152,.0722])
def rgb(p):return np.asarray(Image.open(p).convert('RGB'),dtype='f')
def display(linear):
    x=np.maximum(0,linear)
    return 255*np.power(np.clip(x*(2.51*x+.03)/(x*(2.43*x+.59)+.14),0,1),1/2.2)
def load_ref(p):
    a=np.load(p);alpha=a[:,:,3:4];return a[:,:,:3]/np.maximum(alpha,1e-6),alpha
def metric(r,t,m):
    a=r[m]@weights;b=t[m]@weights
    return {'pixels':int(m.sum()),'rasterMedianLuma':round(float(np.median(a)),2),'cyclesMedianLuma':round(float(np.median(b)),2),
            'meanAbsLumaError':round(float(np.abs(a-b).mean()),2),'meanSignedLumaError':round(float(np.mean(a-b)),2)}
def font(size):return ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',size)
def to_image(arr):return Image.fromarray(np.round(arr).clip(0,255).astype('u1'))
cellw,cellh=320,240
panel=Image.new('RGB',(1040,1205),(20,24,26));draw=ImageDraw.Draw(panel)
draw.text((22,18),'Forest lighting comparison',font=font(28),fill='#f6f4ed')
draw.text((23,59),'Matched cameras and materials  /  96 samples per pixel  /  six path bounces',font=font(16),fill='#b9c6c2')
for k,label in enumerate(['Live raster','Cycles foreground','Absolute luminance error']):
    draw.text((22+k*339,99),label,font=font(17),fill='#f6f4ed')
report={'renderer':'Blender 4.3.2 Cycles CPU','raster':'production WebGL2 GLES release draw replay on native Mesa, 4x MSAA','shadowMode':'release near/wide PCF plus measured crown source transfer','calibration':{},'comparisons':{}}
records=[('crown','front','Crown toward the sun'),('crown','back','Crown against the sun'),('crown','side','Crown in side light'),('grass','front','Walking-height meadow')]
for row,(kind,view,title) in enumerate(records):
    p=root/kind;fixture=json.loads((p/'scene.json').read_text());shot=rgb(p/f'raster-{view}.png');mask=rgb(p/f'mask-{view}.png')
    source,alpha=load_ref(p/f'cycles-{view}.npy');target=display(source)
    bg=rgb(p/f'background-{view}.png')
    ref=target*alpha+bg*(1-alpha)
    coverage=(mask[:,:,0]>=254)&(alpha[:,:,0]>=.98)
    assert coverage.sum()>700
    key=kind+'-'+view
    m=metric(shot,target,coverage)
    heat=np.zeros_like(shot)+[25,29,31]
    luma_error=np.abs((shot-target)@weights);t=np.clip(luma_error/48,0,1)
    anchors=np.array([[29,39,36],[51,103,90],[235,166,67],[253,237,202]])
    a=np.minimum(2,np.floor(t*3).astype(int));f=(t*3-a)[:,:,None]
    heat[coverage]=(anchors[a]*(1-f)+anchors[a+1]*f)[coverage]
    names=['raster-'+view+'.png','cycles-'+view+'.exr','mask-'+view+'.png','scene.json']
    m.update({'geometry':fixture.get('species','release meadow'),'triangles':(p/('plants.u32' if kind=='grass' else 'tree.u32')).stat().st_size//12,'camera':fixture['position'],'target':fixture['target'],'size':[fixture['width'],fixture['height']],'sunElevation':fixture['sunElevation'],'sunAzimuth':fixture['views'][view],'VFoV':50,'wind':0,'samplesPerPixel':96,'maxBounces':6,'sha256':{n:hashlib.sha256((p/n).read_bytes()).hexdigest() for n in names}})
    if kind=='grass':m['rootCount']=fixture['roots']
    if kind=='crown':m.update({'sourceInstanceIndex':fixture['id'],'otherTreeCountWithin40m':len(fixture['otherTreesWithin40m'])})
    deep=coverage&(mask[:,:,2]<32);lit=coverage&(mask[:,:,2]>191)
    for name,sub in [('rasterDeepShade',deep),('rasterDirectlyLit',lit)]:
        if sub.sum():m[name]=metric(shot,target,sub)
    with np.load(p/f'passes-{view}.npz') as passes:
        energy=lambda v:float((v[coverage]@weights).sum())
        total=energy(source)
        groups={name:energy(passes['Combined_'+name]) for name in ['Solar','Sky']}
        denominator=sum(groups.values())
        assert abs(energy(source*alpha)-denominator)/denominator<.01,'Light groups do not reconstruct combined radiance'
        m['lightSourceFraction']={k:round(v/denominator,4) for k,v in groups.items()}
        direct=sum(passes[name+'Col']*passes[name+'Dir'] for name in ['Diff','Gloss','Trans'])
        indirect=sum(passes[name+'Col']*passes[name+'Ind'] for name in ['Diff','Gloss','Trans'])
        m['indirectFraction']=round(energy(indirect)/energy(direct+indirect),4)
    ablated=root/(kind+'-opaque')/('cycles-'+view+'.npy')
    if ablated.exists():
        v,a=load_ref(ablated);paired=coverage&(a[:,:,0]>.98)
        m['thinTransmissionAblation']={'pairedPixels':int(paired.sum()),'dropInMeanLinearLuminanceFraction':round(float(1-(v[paired]@weights).mean()/(source[paired]@weights).mean()),4),'samplesWithTransmission':96,'samplesWithoutTransmission':64}
    run=json.loads((p/('raster-'+view)/'commands.json').read_text())
    m['runtimeSourceSHA256']=run.get('sourceHashes',{});m['normalAssetSHA256']=hashlib.sha256((Path(__file__).resolve().parents[2]/'dist/assets/normal.bin').read_bytes()).hexdigest()
    report['comparisons'][key]=m
    y=132+row*257
    for k,arr in enumerate((shot,ref,heat)):
        tile=to_image(arr).resize((cellw,cellh),Image.Resampling.LANCZOS if k<2 else Image.Resampling.NEAREST);panel.paste(tile,(22+k*339,y))
    draw.text((28,y+8),title,font=font(12),fill='white',stroke_width=2,stroke_fill='#202825')
draw.text((22,1169),'Error shown on fully covered leaves only. Dark green = 0, amber = 32, cream = 48+ display levels.',font=font(15),fill='#d5dfda')
panel.save(out/'lighting-reference.jpg',quality=93,subsampling=0)
if args.calibration:
    p=args.calibration
    for view in ['front','back','side']:
        source,alpha=load_ref(p/f'cycles-{view}.npy');target=display(source);c=rgb(p/'mask.png')
        active=(alpha[:,:,0]>=.98)&(c[:,:,0]>250)
        report['calibration'][view]={name:metric(rgb(p/f'{tag}-{view}.png'),target,active) for name,tag in [('v8','before'),('revisedLighting','quarter')]}
report['method']=['Each comparison uses the actual near tree mesh or the 3.5 m radius seeded meadow around the test viewpoint. Cycles traces up to six surface bounces in a rotated 2K scene HDR with its solar disk separated into a finite 0.53 degree sun. The direct source is scaled by the local photographic cloud transmission at the centre of the patch. The raster uses the same field at every fragment.',
    'The meadow export executes the live GLES vertex shader in transform feedback and retains positions, normals, tint, material layer and UV. Local terrain uses the height query and approximate local soil/vegetation reflectance for secondary rays. The tree case uses the isolated specimen plus a 128 m terrain tile. It excludes distant forest and aerial transport. The complete valley is not path-traced.',
    'The Cycles thin-surface shader uses the resident linear reflected pigment, rough dielectric specular, and bounded diffuse transmission (0.32 of tree pigment, 0.50 of meadow pigment, less the surface Fresnel budget). These are assumed material parameters, not laboratory measurements. Independent diffuse lighting, ray-traced self-shadow, and leaf-to-leaf bounces are enabled.',
    'Images show the Cycles vegetation over its original raster background. The error image excludes background, silhouettes, wood and mixed pixels: photometric comparisons require fully leaf-covered raster samples and Cycles alpha at least 0.98. Luminance metrics use the release filmic curve, gamma 1/2.2 and Rec.709 weights in 0–255 display units.',
    'Light-source and indirect fractions are computed in scene-linear space from Cycles light groups and color-weighted direct/indirect diffuse, glossy and transmission passes. Cycles includes its translucent closure in diffuse passes. The separate ablation measures the effect of disabling that closure including changed subsequent bounces. It is a finite-sample estimate.',
    'Calibration holds the V8 mesh and camera fixed before applying the lighting changes. The final comparisons use the release terrain, placement and botanical changes; their camera coordinates follow the terrain elevation. Curved normal maps, texture sampling, stochastic cutout and limited secondary-scene geometry contribute residual differences.']
(out/'lighting-reference.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:{n:r.get(n) for n in ['pixels','rasterMedianLuma','cyclesMedianLuma','meanAbsLumaError','indirectFraction','thinTransmissionAblation']} for k,r in report['comparisons'].items()},indent=2))
