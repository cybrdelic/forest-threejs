# Dense photographic meadow slices

The runtime grass patches are sixteen spatial depth slabs derived from genuine original Poly Haven Grass Medium 01 geometry. Each source patch contains 64 complete authored specimens, with their original UV photographs and authored embedded RGBA8 opacity. Six slabs capture each vertical axis and four capture the horizontal axis. Every slab renders only geometry inside its corresponding depth interval. This preserves volume from eye level and from an aerial camera with 32 runtime triangles per patch.

The source plants retain native metre scale, including stems up to 0.323 m. The two deterministic source clusters contain 120,487 and 109,981 triangles and have estimated original unclipped leaf-area indices 2.51 and 2.27 over a 0.6 ×0.6 m tile. Runtime card opaque area is a projection-dependent representation estimate rather than an independent physical leaf-area measurement.

Requirements are Python 3, NumPy, SciPy, Pillow, and Linux Mesa EGL/OpenGL ES 3. No conversion dependencies are needed by the browser application. Original author attribution is Rico Cilliers for modeling and Rob Tuytel for photography. The model and photographic surfaces are CC0, from https://polyhaven.com/a/grass_medium_01 with license https://polyhaven.com/license.

From the repository root, choose local input/output folders and run:

```sh
python tools/meadow/download-source.py --asset-root qa-output/meadow/source
python tools/meadow/measure-source-area.py --asset-root qa-output/meadow/source
python tools/meadow/prepare-clusters.py --asset-root qa-output/meadow/source --output qa-output/meadow/dense-source
LIBGL_ALWAYS_SOFTWARE=true python tools/meadow/bake-slices.py --source qa-output/meadow/dense-source/bermuda --name bermuda --output qa-output/meadow/baked
LIBGL_ALWAYS_SOFTWARE=true python tools/meadow/bake-slices.py --source qa-output/meadow/dense-source/grass --name grass --output qa-output/meadow/baked
```

The output includes 64-vertex/96-index runtime meshes, a 512² RGBA albedo/opacity atlas, a 512² tangent normal atlas, and conversion metadata. Each of the sixteen atlas cells is 128² after 2× supersampling. Albedo is encoded back to sRGB after coverage-weighted linear filtering, for the application's sRGB material array. The normal atlas is linear data in the card's UV tangent basis `(right, -up, capture view)` because image UV V increases downward. Normals face the capture direction before supersampling. Source RGB is dilated from fully opaque photographic leaf interiors before filtering. Source mip levels are filtered explicitly in linear light with RGB weighted by authored opacity, then uploaded as sRGB. This prevents hidden white photograph RGB from contaminating minified green blades. The authored alpha remains coverage data.

Source preparation must preserve the official diffuse PNG's embedded RGBA8 alpha. Do not clip a separate 16-bit opacity PNG through Pillow's `convert('L')`. Source data is downloaded through the official Poly Haven API and checked against its MD5 records. The generator ignores catalog-layout translations and places the authored specimens into deterministic spatial clusters. It does not create a scene photograph or synthesize replacement blades.

Copy inspected baked meshes and images into `dist/assets/meadow/`, rebuild the nine-layer application material arrays with the project's packing tool, and regenerate source downloads. Requalify the actual renderer after changing those assets. The downloadable original Celandine and Dandelion conversion assets retain authored geometry. The walking scene uses their two dense base grasses with an upper canopy built in dist/meadow-botany.js. Its flowering stalks use three complete photographed celandine flower faces in separate UV islands on cupped 3D heads. The seeding community uses large photographed dandelion heads and serrated leaf surfaces mapped along the midrib. Culms and grain are modeled and dynamically lit.
