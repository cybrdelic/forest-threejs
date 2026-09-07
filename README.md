# CYBR FOREST

Native C++20 rendering and procedural vegetation built from the restored CYBR VEG forest. This repository keeps the original 3D scene separate from the higher-detail upgrade.

## Publication status

The original GPL-2.0 license is retained. Source and media are being imported from the recovered project. Binary scene/media transfer is not complete; the presence of this README does not mean the films or GLB have been uploaded.

The restored baseline is a 4-second, 1920 x 1080, 24 fps, two-shot native-code render. Its forest geometry is real triangles and instances; it is not the rejected 2.5D replacement. Its diffuse cache and approximate volumetrics do not establish full path-tracing convergence.

## Quality targets

Preserve original geometry; repair normals and tangent frames; invalidate lighting and accumulation using all dependencies; rebuild connected foreground trees, divided fern fronds and hollow fallen logs; improve texture minification; verify uncached sunlight/skylight passes and moving-camera renders before extending the film.

Generated reference pictures, rejected 2.5D footage, missing-file reports and uncreated artifacts are not production renders and are excluded from the render gallery.
