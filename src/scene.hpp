#pragma once
#include "math.hpp"
#include <filesystem>
#include <fstream>
#include <numeric>
#include <string>
#include <vector>
namespace cybr {
    struct Vertex {
        V3 p, n;
        V2 uv;
        V3 color;
    };
    static_assert(sizeof(Vertex) == 44);
    struct Face {
        uint32_t a, b, c, material;
    };
    struct Tri {
        V3 p, e1, e2;
        uint32_t face;
    };
    struct Node {
        V3 lo;
        uint32_t first = 0;
        V3 hi;
        uint32_t count = 0;
    };
    static_assert(sizeof(Node) == 32);
    struct alignas(16) WideNode {
        float lx[4], ly[4], lz[4], hx[4], hy[4], hz[4];
        uint32_t first[4], count[4];
    };
    static_assert(sizeof(WideNode) == 128);
    struct alignas(16) TrianglePacket {
        float px[4], py[4], pz[4], ax[4], ay[4], az[4], bx[4], by[4], bz[4];
        uint32_t face[4];
    };
    static_assert(sizeof(TrianglePacket) == 160);
    struct BVH {
        std::vector < Node > nodes;
        std::vector < WideNode > wide;
        void makeWide();
        std::vector < uint32_t > indices;
        void build(const std::vector < Box > & bounds, uint32_t leafSize = 4);
    };
    struct Mesh {
        std::string name;
        std::vector < Vertex > vertices;
        std::vector < Face > faces;
        std::vector < Tri > triangles;
        std::vector < TrianglePacket > packets;
        BVH bvh;
        Box bounds;
        void build();
        void recomputeNormals();
    };
    struct Instance {
        uint32_t mesh = 0;
        Affine transform, inverse;
        V3 tint {
            1
        };
        Box bounds;
    };
    struct Camera {
        std::string name;
        V3 eye, target, up {
            0, 1, 0
        };
        float fov = 49;
        Ray generate(float px, float py, int width, int height, RNG & rng, float aperture, float focus) const;
    };
    struct Hit {
        float t = Inf, u = 0, v = 0;
        uint32_t instance = ~ 0u, face = ~ 0u;
    };
    struct Surface {
        V3 p, local, n, ng, tangent, bitangent, color;
        V2 uv;
        float footprint = 0;
        V2 uvFootprint{};
        uint32_t material;
    };
    struct Scene {
        std::vector < Mesh > meshes;
        std::vector < Instance > instances;
        std::vector < Camera > cameras;
        BVH tlas;
        uint64_t fingerprint = 0;
        void load(const std::filesystem::path & path);
        bool intersect(const Ray & ray, Hit & h, const BVH* visibilityTree=nullptr) const;
        bool occluded(const Ray & ray) const;
        // Coherence hints only name primitives. All candidates are intersected
        // with the current ray and all nearer geometry is still traversed.
        bool primitiveHit(const Ray& ray, Hit& hit, uint32_t instance, uint32_t face) const;
        bool intersectHint(const Ray& ray, Hit& hit, const Hit& hint, const BVH* visibilityTree=nullptr) const;
        bool occludedHint(const Ray& ray, Hit& hint) const;
        Surface surface(const Ray & ray, const Hit & hit) const;
    };
    struct Texel {
        V3 color;
        float du = 0, dv = 0, rough = 1, height = 0;
    };
    static_assert(sizeof(Texel) == 28);
    struct TextureLevel {
        uint32_t width = 0, height = 0;
        std::vector<Texel> pixels;
    };
    struct Texture {
        uint32_t width = 0, height = 0;
        std::vector < Texel > pixels;
        uint64_t fingerprint = 0;
        std::vector<TextureLevel> mipmaps; // Starts at half resolution; base pixels remain intact.
        void load(const std::filesystem::path & path);
        void buildMipmaps();
        Texel sample(float u, float v, float footprint = 0) const;
    };
}
