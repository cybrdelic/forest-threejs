# First verified foreground/rendering upgrade

This is an engineering and asset upgrade, not a claim that AAA photorealism or complete light-transport convergence has been achieved.

## Baseline preservation

Commit `81864d9c88eec5d8ee5ac200699d6a17cecb3378` preserves the restored renderer and its real four-frame GIF thumbnail. All 25 original GLB mesh buffers are kept unchanged by the upgraded scene builder. Selected instances reference additional edited meshes. The original input GLB remains a separate immutable input.

## Implemented

- Recomputed deformation normals and UV-derived orthonormal tangent frames, including mirrored UV orientation.
- Native lighting fingerprints include geometry, bark/soil texels, light/medium settings, depth, emitter mode, camera/renderer source and compiler/build settings.
- Accumulation and film output identities reject stale or mixed settings. File existence alone cannot establish that a frame belongs to the current job.
- Periodic trilinear mip filtering with approximate camera ray-cone footprints; original high-frequency levels remain available for close views.
- Three foreground tree copies with connected root/trunk bases, real bark relief and retained crowns; four substantial divided-fern prototypes across 198 existing placements, seven extra foreground clumps, and a hollow, ragged fallen log with bracket fungi.
- Rest-referenced kinematic wind updates real vertex positions, inverse-Jacobian normals, primitive packets and scene bounds. Root anchors remain fixed. This is not a validated mechanical wind solver.
- Film aperture sampling is available. Temporal history is disabled for wind/aperture because proper moving-surface correspondence is not implemented. Static history now checks instance and primitive identity.
- Empty/repeated acceleration-structure rebuilds clear stale nodes, packets and bounds.

The generated scene was measured locally: 34 mesh buffers, 9,818 instances, 1,241,642 unique triangles and 19,392,774 instance-expanded triangles. No nonunit normals or zero-area faces were found under the declared generator checks. Three initial upper crowns still retain intersecting source branch junctions; the lower joined bases do not make entire trees watertight.

## Tests actually run locally

Four native CTest suites passed in Release and AddressSanitizer/UndefinedBehaviorSanitizer builds, including 47 new quality checks. The actual upgraded forest was rendered uncached at 320 x 180 / 64 spp in sun-only, sky-only and combined surface-lighting passes with the atmosphere disabled. Maximum absolute linear channel residual was 5.4529e-7. Eight film-setting mutations rejected stale output identities. These tests do not certify visual realism or convergence.

## Reproduce

The original scene and materials must first be installed. They are not reconstructed from the small GIF or downloaded by the source import workflow.

```sh
python -m pip install -r requirements.txt
python tools/build_quality_scene.py
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel 4
ctest --test-dir build --output-on-failure
python tools/quality_validation.py
build/cybr-film --assets assets --out renders/cachebuild --mode gather --camera-steps 4 --cell .8 --first 0 --last 11 --threads 4
build/cybr-film --assets assets --out renders/cachebuild --mode bake --cache-min 128 --cache-max 512 --target .04 --threads 4
build/cybr-film --assets assets --out renders/cachebuild --mode volume --threads 4
python tools/quality_film.py --profile both
```

`proof` targets a four-second 1080p two-shot motion proof; `film` targets twelve two-second 720p shots. Native rendering and encoding reports, not these configured targets, establish completion. The movie uses four new camera samples per pixel, cached diffuse illumination and approximate volumetrics; cached indirect light/volume are frozen at the rest pose while direct visibility follows wind. It is not an independently converged per-frame film. The uncached `reference` and `uncached-film` modes remain available for higher-cost validation.

## Publication boundary

The source importer verifies every starting and resulting source hash, applies the preserved patch, builds and tests before committing readable files. It transfers source only. The full-size movie/GLB/GIF bundle remains a separate binary upload task. `reports/publication-status.json` must not mark that task complete until repository bytes match the manifest.
