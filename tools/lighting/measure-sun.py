"""Integrate the HDR solar disk in the same irradiance-over-pi units as the sky."""
import argparse
import importlib.util
import json
from pathlib import Path
import numpy as np
root=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('source',type=Path)
args=parser.parse_args()
spec=importlib.util.spec_from_file_location('cloud_conversion',root/'tools/cloud-transmittance.py')
cloud=importlib.util.module_from_spec(spec);spec.loader.exec_module(cloud)
image=cloud.read_rgbe(args.source)
h,w=image.shape[:2]
y,x=np.indices((h,w))
theta=(y+.5)*np.pi/(2*h)
phi=((x+.5)/w-.5)*2*np.pi
sun=np.array([.5545620063,.7419804117,.3767307391])
directions=np.stack((np.sin(theta)*np.cos(phi),np.cos(theta),np.sin(theta)*np.sin(phi)),axis=-1)
angle=np.arccos(np.clip(directions@sun,-1,1))
solid=np.sin(theta)*np.pi/(2*h)*2*np.pi/w
mask=angle<np.deg2rad(1)
flux=np.sum(image*solid[...,None]*mask[...,None],axis=(0,1))/np.pi
print(json.dumps({'source':str(args.source),'coneHalfAngleDegrees':1,'solarIrradianceOverPi':flux.tolist(),'selectedPixels':int(mask.sum())}))
