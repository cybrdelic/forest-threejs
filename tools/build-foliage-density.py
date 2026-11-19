"""Build model-space leaf-area-density volumes from true UV-cutout tree geometry.

Input is the nine-float full-source interchange documented by bake-impostors.py.
Usage: python tools/build-foliage-density.py --source /path/to/tree --name oak
"""
from argparse import ArgumentParser
from pathlib import Path
import json
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, map_coordinates

parser = ArgumentParser()
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--name', required=True)
parser.add_argument('--size', type=int, default=96)
parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1]/'dist/assets/impostors')
args = parser.parse_args()
metadata = json.loads((args.source/'metadata.json').read_text())
vertices = np.memmap(args.source/'vertices.bin', dtype=np.float32, mode='r').reshape(-1, 9)
indices = np.memmap(args.source/'indices.bin', dtype=np.uint32, mode='r')
lower, upper = np.asarray(metadata['bounds'], dtype=np.float64)
minimum = lower-1.0
extent = upper-lower+2.0
side = args.size
density = np.zeros((side, side, side), dtype=np.float64)
total_area = 0.0
source_triangles = 0
for primitive in metadata['primitives']:
    if primitive['material'] != 2:
        continue
    texture_path = Path(primitive['diffuse_texture'])
    if not texture_path.exists():
        texture_path = args.source/texture_path.name
    texture = np.asarray(Image.open(texture_path).convert('RGBA'), dtype=np.float32)
    alpha = texture[:, :, 3]/255.0
    height, width = alpha.shape
    end = primitive['indexFirst']+primitive['indexCount']
    for first in range(primitive['indexFirst'], end, 300000):
        ids = indices[first:min(first+300000, end)].reshape(-1, 3)
        triangles = vertices[ids, :3]
        area = np.linalg.norm(np.cross(triangles[:,1]-triangles[:,0], triangles[:,2]-triangles[:,0]), axis=1)*0.5
        center = triangles.mean(axis=1)
        uv = vertices[ids,6:8].mean(axis=1)
        coverage = map_coordinates(alpha, [np.mod(uv[:,1],1)*(height-1), np.mod(uv[:,0],1)*(width-1)], order=1, mode='nearest')
        leaf_area = area*coverage
        cell = np.clip(((center-minimum)/extent*side).astype(np.int32), 0, side-1)
        np.add.at(density, tuple(cell.T), leaf_area)
        total_area += float(leaf_area.sum())
        source_triangles += len(ids)
voxel_volume = float(np.prod(extent/side))
density = gaussian_filter(density, 1.1, mode='constant')/voxel_volume
positive = density[density>1e-5]
scale = float(np.quantile(positive,0.9999)) if len(positive) else 1.0
encoded = np.round(np.clip(density/scale,0,1)*255).astype(np.uint8)
decoded = encoded.astype(np.float64)/255*scale
args.output.mkdir(parents=True, exist_ok=True)
# The API texture layout has X fastest, then Y, then Z.
encoded.transpose(2,1,0).copy().tofile(args.output/(args.name+'-density.bin'))
result = {
    'size': side, 'minimum': minimum.tolist(), 'extent': extent.tolist(),
    'decodeScale': scale, 'encoding': 'R8_UNORM * decodeScale, X fastest / Y / Z',
    'units': 'square metres of projected alpha-weighted leaf surface per cubic metre',
    'source': metadata.get('source_url'), 'license': 'CC0',
    'sourceLeafTriangles': source_triangles, 'sourceLeafAreaSquareMetres': total_area,
    'decodedLeafAreaSquareMetres': float(decoded.sum()*voxel_volume),
    'relativeAreaError': float((decoded.sum()*voxel_volume-total_area)/max(total_area,1e-9)),
    'smoothing': 'Gaussian sigma 1.1 voxels, preserving integrated leaf area before quantization',
    'clipping': '99.99 percentile of nonzero density, rather than one outlier setting all quantization precision',
    'extinction': 'Runtime Beer-Lambert k=0.5 along the current model-space sunlight direction',
    'limits': 'Centroid UV alpha quadrature and voxel smoothing approximate individual leaves; branch wood is excluded.'
}
(args.output/(args.name+'-density.json')).write_text(json.dumps(result, indent=2)+'\n')
print(json.dumps(result), flush=True)
