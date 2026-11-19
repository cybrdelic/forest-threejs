"""Reconstruct an ortho canopy surface from the measured leaf-density fields.

The far terrain already contains the large-scale top and surrounding horizons.
This periodic patch supplies sub-grid crown relief and sky shelter (no baked sun).
"""
from pathlib import Path
import json
import numpy as np
from scipy.ndimage import gaussian_filter, map_coordinates

assets = Path(__file__).resolve().parents[2] / 'dist/assets'
size, metres = 512, 256
spacing = metres / size
rng = np.random.default_rng(98264)
profiles = []
for name in ['oak', 'jacaranda']:
    info = json.loads((assets/'impostors'/f'{name}-density.json').read_text())
    n = info['size']
    extent, low = np.array(info['extent']), np.array(info['minimum'])
    lad = np.fromfile(assets/'impostors'/f'{name}-density.bin', np.uint8).reshape(n, n, n)
    optical = lad[:, ::-1, :].astype(float) * (0.5 * info['decodeScale'] / 255 * extent[1] / n)
    tau = np.cumsum(optical, axis=1)
    absorption = np.exp(-tau + optical) * (-np.expm1(-optical))
    height = low[1] + (n - np.arange(n) - .5) * extent[1] / n
    # A sparse shoot exposes the neighbouring lower stand. Include that chance
    # when collapsing the vertical optical profile to an effective surface.
    profiles.append(((absorption * height[None, :, None]).sum(axis=1), low, extent))

surface = np.zeros((size, size), np.float32)
# Jittered spacing, natural recruitment and unequal competition for canopy light.
for row in range(30):
    for col in range(30):
        profile, low, extent = profiles[int(rng.random() < .29)]
        cx, cz = (np.array([col, row]) + rng.random(2)) * metres / 30
        angle = rng.uniform(-np.pi, np.pi)
        scale = rng.uniform(.72, 1.36)
        width = scale * rng.uniform(.81, 1.15)
        radius = np.hypot(extent[0], extent[2]) * width
        ix = np.arange(np.floor((cx-radius)/spacing), np.ceil((cx+radius)/spacing), dtype=int)
        iz = np.arange(np.floor((cz-radius)/spacing), np.ceil((cz+radius)/spacing), dtype=int)
        x, z = np.meshgrid((ix+.5)*spacing-cx, (iz+.5)*spacing-cz)
        qx = (np.cos(angle)*x-np.sin(angle)*z)/width
        qz = (np.sin(angle)*x+np.cos(angle)*z)/width
        source = [(qz-low[2])/extent[2]*profile.shape[0]-.5, (qx-low[0])/extent[0]*profile.shape[1]-.5]
        top = scale * map_coordinates(profile,source,order=1,mode='constant')
        idx = np.ix_(iz % size, ix % size)
        surface[idx] = np.maximum(surface[idx], top)
# Sub-grid roughness is primarily the crown, not every leaf on that crown.
smoothed = gaussian_filter(surface, 1.85 / spacing, mode='wrap')
slope_x = (np.roll(smoothed,-1,axis=1)-np.roll(smoothed,1,axis=1))/(2*spacing)
slope_z = (np.roll(smoothed,-1,axis=0)-np.roll(smoothed,1,axis=0))/(2*spacing)
inv_len = 1/np.sqrt(1+slope_x*slope_x+slope_z*slope_z)
openness = np.zeros_like(surface)
for angle in np.arange(16)*np.pi/8:
    horizon = np.zeros_like(surface)
    for step in [2, 4, 8, 16, 28, 46]:
        dx, dz = np.rint([np.cos(angle)*step, np.sin(angle)*step]).astype(int)
        neighbour = np.roll(smoothed, (-dz, -dx), axis=(0,1))
        horizon = np.maximum(horizon, (neighbour - smoothed)/(spacing*np.hypot(dx,dz)))
    openness += (1/16)/(1+horizon*horizon)
field = np.stack([.5-.5*slope_x*inv_len,.5-.5*slope_z*inv_len,openness,inv_len],axis=-1)
path = assets / 'stand-relief.bin'
with path.open('wb') as handle:
    while True:
        np.rint(np.clip(field,0,1)*255).astype(np.uint8).tofile(handle)
        if field.shape[0] == 1: break
        half = field.shape[0]//2
        field = field.reshape(half,2,half,2,4).mean(axis=(1,3))
print('height range and mean aperture',np.quantile(smoothed,[.05,.95]).tolist(),float(openness.mean()),'asset bytes',path.stat().st_size)
