# Vegetation lighting reference

These offline comparisons use the actual solitary tree in the opposite pasture and a grazing-height tile of the interactive meadow. The browser renders the full world for the raster images. Cycles traces the selected vegetation and nearby terrain. The error map measures only pixels covered by leaves in both renders.

The workflow uses Node.js, Python with NumPy and Pillow, surfaceless EGL/GLES3 and Blender 4.3 with Cycles CPU. Start in the repository root and place all generated working files outside the checkout.

```bash
work=/tmp/forest-lighting
mkdir -p "$work/crown" "$work/grass"
node tools/reference/tree-scene.mjs "$work/crown"
node tools/reference/meadow-scene.mjs "$work/grass"
python tools/reference/capture-raster.py "$work/crown"
python tools/reference/capture-raster.py "$work/grass"
python tools/reference/plant-feedback.py "$work/grass"

for subject in crown grass; do
  folder="$work/$subject"
  blender -b -t 2 --factory-startup --python-exit-code 1 -P tools/reference/cycles-crown.py -- "$folder" 96
  blender -b -t 1 --python-exit-code 1 -P tools/reference/load-passes.py -- "$folder"
  for shot in "$folder"/raster-*.png; do
    name=$(basename "$shot" .png)
    name=${name#raster-}
    kind=tree
    if [ "$subject" = grass ]; then kind=meadow; fi
    python tools/reference/coverage-mask.py "$folder/raster-$name" "$folder/mask-$name.png" "$kind"
    python tools/reference/coverage-mask.py "$folder/raster-$name" "$folder/background-$name.png" background
  done
done
python tools/reference/compare.py "$work" "$work/evidence"
```

The optional transmission ablation takes the same fixture, camera and materials with `FOREST_REFERENCE_TRANSMISSION=0`. The comparison tool looks for the resulting `cycles-back.npy` in `crown-opaque/` and `cycles-front.npy` in `grass-opaque/` next to the regular renders. Use 64 samples for these ablations. The pre-update calibration table requires a separate `--calibration` directory containing the fixed V8-geometry three-angle pair and matching material matte.

The complete-scene raster backgrounds are shared for visual comparison. The pass arithmetic, exposure, image hashes, common-pixel counts, terrain approximation and sampled radiance differences are recorded with the shipped proof.
