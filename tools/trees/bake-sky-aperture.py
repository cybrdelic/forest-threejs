"""Integrate the upper-sky opening of the two source crowns at their released surfaces.

Run after rebuilding either the near/mid geometry or the impostor atlases.
Only the sky-transfer byte changes. Positions, texture alpha, normals, sun
transfer, UVs and triangle topology are preserved.
"""
import argparse
import json
import struct
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates, shift

ROOT = Path(__file__).resolve().parents[2]
ATLAS = ROOT / "dist/assets/impostors"


def aperture_grid(density, cell, rays, phase=0.0):
    """Cosine-weighted sky hemisphere. Sweep along each ray's dominant axis.

    The transport step is always at most one grid cell in each component.
    Beer attenuation uses a leaf projection factor of 0.5 and trapezoidal
    extinction at successive voxel centers. The last half cell at every
    volume boundary accounts for its outgoing path to the exterior.
    """
    result = np.zeros_like(density)
    for i in range(rays):
        radial = np.sqrt((i + 0.5) / rays)
        angle = i * np.pi * (3 - np.sqrt(5)) + phase
        direction = np.array([np.cos(angle) * radial, np.sqrt(1 - radial**2), np.sin(angle) * radial])
        grid_direction = direction / cell
        axis = int(np.argmax(np.abs(grid_direction)))
        order = [a for a in range(3) if a != axis]
        order.insert(0, axis)
        field = density.transpose(order)
        sign = 1 if direction[axis] > 0 else -1
        step = 1 / abs(grid_direction[axis])
        advance = grid_direction[order[1:]] * step
        depth = np.zeros_like(field)
        sweep = range(len(field)-1, -1, -1) if sign == 1 else range(len(field))
        for j in sweep:
            half = field[j] * (0.25 * step)
            ahead = j + sign
            if 0 <= ahead < len(field):
                # grid-constant interpolates the exterior vacuum at boundaries.
                carried = shift(depth[ahead] + field[ahead]*(0.25*step), -advance,
                                order=1, mode="grid-constant", cval=0, prefilter=False)
                depth[j] = half + carried
            else:
                depth[j] = half
        result += np.exp(-depth.transpose(np.argsort(order))) / rays
    return result


def surface_samples(field, meta, xyz):
    uvw = (xyz - meta["minimum"]) / meta["extent"] * meta["size"] - 0.5
    sky = map_coordinates(field, uvw.T, order=1, mode="nearest", prefilter=False)
    return np.clip(np.rint(sky * 255), 0, 255).astype(np.uint8)


def bake(species, rays, verify):
    meta = json.loads((ATLAS / (species+"-density.json")).read_text())
    size = meta["size"]
    density = np.fromfile(ATLAS/(species+"-density.bin"), np.uint8).reshape([size]*3).transpose(2,1,0)
    density = density.astype(np.float32) * (meta["decodeScale"] / 255)
    cell = np.asarray(meta["extent"]) / size
    sky = aperture_grid(density, cell, rays)
    evidence = {"rays": rays}
    if verify:
        control = aperture_grid(density, cell, rays*2, np.pi/5)
        difference = (control - sky)[density > 0.02]
        evidence["doubledQuadratureRmse"] = float(np.sqrt(np.mean(difference**2)))
        evidence["doubledQuadratureP95Absolute"] = float(np.quantile(np.abs(difference), .95))
    directory = ROOT / "dist/assets" / ("trees" if species == "oak" else "jacaranda")
    for level in ["near", "mid"]:
        target = directory / (level+"-vertices.bin")
        storage = bytearray(target.read_bytes())
        tag, count, *bounds = struct.unpack("<4sI6f", storage[:32])
        assert tag == b"TRV6" and len(storage) == 32 + count*22
        xyz = np.ndarray((count, 3), dtype="<u2", buffer=storage, offset=32, strides=(22, 2))
        position = xyz / 65535 * np.asarray(bounds[3:]) + bounds[:3]
        vertices = np.frombuffer(storage, np.uint8, offset=32).reshape(-1,22)
        vertices[:, 15] = surface_samples(sky, meta, position)
        target.write_bytes(storage)

    tree_path = ATLAS/(species+".json")
    tree = json.loads(tree_path.read_text())
    lo, hi = np.array(tree["sourceBounds"])
    positions = np.asarray(Image.open(ATLAS/(species+"-position.png")))
    position = lo + positions[:,:,:3].reshape(-1,3).astype(np.float32)/255*(hi-lo)
    target = ATLAS/(species+"-normal.png")
    normals = np.asarray(Image.open(target).convert("RGBA")).copy()
    normals[:,:,3] = surface_samples(sky, meta, position).reshape(normals.shape[:2])
    Image.fromarray(normals).save(target, optimize=True)
    tree["normalSpace"] = ("Model-space normal encoded [0,1]; vector length retains unresolved "
                           "normal variance. Alpha stores cosine-weighted upper-hemisphere visibility "
                           "through the source leaf area density at the reconstructed surface.")
    tree["skyAperture"] = {"sourceDensitySize":size, "cosineWeightedDirections":rays,
                            "extinction":0.5, "details":"tools/trees/bake-sky-aperture.py"}
    tree_path.write_text(json.dumps(tree, indent=2)+"\n")
    mask = np.asarray(Image.open(ATLAS/(species+"-albedo.png")))[:,:,3] > 127
    evidence["occupiedPixels"] = int(mask.sum())
    evidence["apertureDeciles"] = np.quantile(normals[:,:,3][mask]/255, [.1,.5,.9]).tolist()
    return evidence


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rays", type=int, default=64)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    for name in ["oak", "jacaranda"]:
        print(name, json.dumps(bake(name,args.rays,args.verify)), flush=True)
