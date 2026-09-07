#include "scene.hpp"
#include <functional>
#include <iostream>
#include <cstring>
#if defined(__SSE2__) || defined(_M_X64)
#include <immintrin.h>
#define CYBR_SIMD 1
#endif
namespace cybr {
    namespace {
        template < class T > void read(std::istream & f, T & x) {
            f.read(reinterpret_cast < char * >(& x), sizeof(x));
            if (! f) throw std::runtime_error("Truncated binary scene");
        }
        void readBytes(std::istream & f, void * p, size_t size) {
            f.read(static_cast < char * >(p), std::streamsize(size));
            if (! f) throw std::runtime_error("Truncated binary array");
        }
        std::string readString(std::istream & f, uint32_t n) {
            if (n > 65536) throw std::runtime_error("Invalid string length");
            std::string s(n, '\0');
            readBytes(f, s.data(), n);
            return s;
        }
        inline bool triHit(const Tri & t, const Ray & r, Hit & h, uint32_t inst) {
            V3 p = cross(r.d, t.e2);
            float det = dot(t.e1, p);
            if (std::abs(det) < 1e-15f) return false;
            float inv = 1 / det;
            V3 s = r.o - t.p;
            float u = dot(s, p) * inv;
            if (u < 0 || u > 1) return false;
            V3 q = cross(s, t.e1);
            float v = dot(r.d, q) * inv;
            if (v < 0 || u + v > 1) return false;
            float d = dot(t.e2, q) * inv;
            if (d < r.tmin || d >= std::min(h.t, r.tmax)) return false;
            h = {
                d, u, v, inst, t.face
            };
            return true;
        }
        inline bool triAny(const Tri & t, const Ray & r) {
            Hit h;
            return triHit(t, r, h, 0);
        }
        inline float nodeNear(const Node & n, const Ray & r, float maxT) {
            return Box {
                n.lo, n.hi
            }
            .nearT(r, maxT);
        }
        struct StackEntry {
            uint32_t i, count;
            float d;
        };
        inline int wideHit(const WideNode & n, const Ray & r, float maxT, float * distances) {
#if CYBR_SIMD
            __m128 ox = _mm_set1_ps(r.o.x), oy = _mm_set1_ps(r.o.y), oz = _mm_set1_ps(r.o.z);
            __m128 ix = _mm_set1_ps(r.inv.x), iy = _mm_set1_ps(r.inv.y), iz = _mm_set1_ps(r.inv.z);
            __m128 ax = _mm_mul_ps(_mm_sub_ps(_mm_load_ps(n.lx), ox), ix), bx = _mm_mul_ps(_mm_sub_ps(_mm_load_ps(n.hx), ox), ix);
            __m128 ay = _mm_mul_ps(_mm_sub_ps(_mm_load_ps(n.ly), oy), iy), by = _mm_mul_ps(_mm_sub_ps(_mm_load_ps(n.hy), oy), iy);
            __m128 az = _mm_mul_ps(_mm_sub_ps(_mm_load_ps(n.lz), oz), iz), bz = _mm_mul_ps(_mm_sub_ps(_mm_load_ps(n.hz), oz), iz);
            __m128 lo = _mm_max_ps(_mm_set1_ps(r.tmin), _mm_max_ps(_mm_min_ps(ax, bx), _mm_max_ps(_mm_min_ps(ay, by), _mm_min_ps(az, bz))));
            __m128 hi = _mm_min_ps(_mm_set1_ps(std::min(maxT, r.tmax)), _mm_min_ps(_mm_max_ps(ax, bx), _mm_min_ps(_mm_max_ps(ay, by), _mm_max_ps(az, bz))));
            _mm_store_ps(distances, lo);
            return _mm_movemask_ps(_mm_and_ps(_mm_cmple_ps(lo, hi), _mm_cmplt_ps(lo, _mm_set1_ps(Inf))));
#else
            int mask = 0;
            for (int i = 0;
            i < 4;
            ++ i) {
                distances[i] = Box {
                    {
                        n.lx[i], n.ly[i], n.lz[i]
                    }, {
                        n.hx[i], n.hy[i], n.hz[i]
                    }
                }
                .nearT(r, maxT);
                if (distances[i] < Inf) mask |= 1 << i;
            }
            return mask;
#endif
        }
        inline bool packetHit(const TrianglePacket & t, const Ray & r, Hit & h, uint32_t inst, bool any) {
#if CYBR_SIMD
            __m128 dx = _mm_set1_ps(r.d.x), dy = _mm_set1_ps(r.d.y), dz = _mm_set1_ps(r.d.z);
            __m128 ax = _mm_load_ps(t.ax), ay = _mm_load_ps(t.ay), az = _mm_load_ps(t.az), bx = _mm_load_ps(t.bx), by = _mm_load_ps(t.by), bz = _mm_load_ps(t.bz);
            __m128 px = _mm_sub_ps(_mm_mul_ps(dy, bz), _mm_mul_ps(dz, by));
            __m128 py = _mm_sub_ps(_mm_mul_ps(dz, bx), _mm_mul_ps(dx, bz));
            __m128 pz = _mm_sub_ps(_mm_mul_ps(dx, by), _mm_mul_ps(dy, bx));
            __m128 det = _mm_add_ps(_mm_mul_ps(ax, px), _mm_add_ps(_mm_mul_ps(ay, py), _mm_mul_ps(az, pz)));
            __m128 inv = _mm_div_ps(_mm_set1_ps(1), det);
            __m128 sx = _mm_sub_ps(_mm_set1_ps(r.o.x), _mm_load_ps(t.px)), sy = _mm_sub_ps(_mm_set1_ps(r.o.y), _mm_load_ps(t.py)), sz = _mm_sub_ps(_mm_set1_ps(r.o.z), _mm_load_ps(t.pz));
            __m128 u = _mm_mul_ps(inv, _mm_add_ps(_mm_mul_ps(sx, px), _mm_add_ps(_mm_mul_ps(sy, py), _mm_mul_ps(sz, pz))));
            __m128 qx = _mm_sub_ps(_mm_mul_ps(sy, az), _mm_mul_ps(sz, ay));
            __m128 qy = _mm_sub_ps(_mm_mul_ps(sz, ax), _mm_mul_ps(sx, az));
            __m128 qz = _mm_sub_ps(_mm_mul_ps(sx, ay), _mm_mul_ps(sy, ax));
            __m128 v = _mm_mul_ps(inv, _mm_add_ps(_mm_mul_ps(dx, qx), _mm_add_ps(_mm_mul_ps(dy, qy), _mm_mul_ps(dz, qz))));
            __m128 distance = _mm_mul_ps(inv, _mm_add_ps(_mm_mul_ps(bx, qx), _mm_add_ps(_mm_mul_ps(by, qy), _mm_mul_ps(bz, qz))));
            __m128 absdet = _mm_andnot_ps(_mm_set1_ps(- 0.0f), det), zero = _mm_setzero_ps();
            __m128 ok = _mm_and_ps(_mm_cmpgt_ps(absdet, _mm_set1_ps(1e-15f)), _mm_and_ps(_mm_cmpge_ps(u, zero), _mm_cmpge_ps(v, zero)));
            ok = _mm_and_ps(ok, _mm_cmple_ps(_mm_add_ps(u, v), _mm_set1_ps(1)));
            ok = _mm_and_ps(ok, _mm_and_ps(_mm_cmpge_ps(distance, _mm_set1_ps(r.tmin)), _mm_cmplt_ps(distance, _mm_set1_ps(std::min(h.t, r.tmax)))));
            int mask = _mm_movemask_ps(ok);
            if (! mask) return false;
            alignas(16) float ds[4], us[4], vs[4];
            _mm_store_ps(ds, distance);
            _mm_store_ps(us, u);
            _mm_store_ps(vs, v);
            for (int i = 0; i < 4; ++i) {
                if ((mask & (1 << i)) && ds[i] < h.t) {
                    h = {ds[i], us[i], vs[i], inst, t.face[i]};
                    if (any) return true;
                }
            }
            return true;
#else
            bool found = false;
            for (int i = 0;
            i < 4;
            ++ i) {
                Tri tri {
                    {
                        t.px[i], t.py[i], t.pz[i]
                    }, {
                        t.ax[i], t.ay[i], t.az[i]
                    }, {
                        t.bx[i], t.by[i], t.bz[i]
                    }, t.face[i]
                };
                if (triHit(tri, r, h, inst)) {
                    if (any) return true;
                    found = true;
                }
            }
            return found;
#endif
        }
        inline void pushHits(const WideNode & node, int mask, const float * ds, StackEntry * stack, int & top) {
            StackEntry hits[4];
            int count = 0;
            for (int i = 0;
            i < 4;
            ++ i) if (mask &(1 << i)) {
                StackEntry h {
                    node.first[i], node.count[i], ds[i]
                };
                int j = count;
                while (j > 0 && hits[j - 1].d < h.d) {
                    hits[j] = hits[j - 1];
                    -- j;
                }
                hits[j] = h;
                ++ count;
            }
            if (top + count > 192) throw std::runtime_error("Wide BVH stack overflow");
            for (int j = 0;
            j < count;
            ++ j) stack[top++] = hits[j];
        }
        bool meshHit(const Mesh & mesh, const Ray & ray, Hit & hit, uint32_t inst, bool any) {
            if (mesh.bvh.wide.empty()) return false;
            StackEntry stack[192];
            int top = 1;
            stack[0] = {
                0, 0, 0
            };
            bool found = false;
            while (top) {
                StackEntry current = stack[-- top];
                if (current.d >= hit.t) continue;
                if (current.count) {
                    for (uint32_t k = current.i;
                    k < current.i + current.count;
                    ++ k) {
                        bool result = packetHit(mesh.packets[k], ray, hit, inst, any);
                        if (result && any) return true;
                        found |= result;
                    }
                } else {
                    const WideNode & node = mesh.bvh.wide[current.i];
                    alignas(16) float ds[4];
                    int mask = wideHit(node, ray, hit.t, ds);
                    pushHits(node, mask, ds, stack, top);
                }
            }
            return found;
        }
    }
    void BVH::build(const std::vector < Box > & bounds, uint32_t leafSize) {
        nodes.clear();
        indices.resize(bounds.size());
        std::iota(indices.begin(), indices.end(), 0u);
        if (bounds.empty()) return;
        nodes.reserve(bounds.size());
        nodes.resize(1);
        std::function < void(uint32_t, uint32_t, uint32_t, int) > split;
        split =[&](uint32_t ni, uint32_t first, uint32_t count, int depth) {
            Box box, centers;
            for (uint32_t k = first;
            k < first + count;
            ++ k) {
                box.add(bounds[indices[k]]);
                centers.add(bounds[indices[k]].center());
            }
            nodes[ni] = {
                box.lo, first, box.hi, count
            };
            if (count <= leafSize || depth >= 60) return;
            constexpr int N = 16;
            int axis = - 1, binSplit = - 1;
            float best = box.area() * float(count);
            for (int ax = 0;
            ax < 3;
            ++ ax) {
                float extent = centers.hi[ax] - centers.lo[ax];
                if (extent < 1e-7f) continue;
                struct Bin {
                    Box b;
                    uint32_t count = 0;
                };
                std::array < Bin, N > bins {
                };
                float scale = N / extent;
                for (uint32_t k = first;
                k < first + count;
                ++ k) {
                    uint32_t i = indices[k];
                    int b = std::clamp(int((bounds[i].center()[ax] - centers.lo[ax]) * scale), 0, N - 1);
                    bins[b].b.add(bounds[i]);
                    ++ bins[b].count;
                }
                float left[N - 1], right[N - 1];
                Box l, r;
                uint32_t nl = 0, nr = 0;
                for (int i = 0;
                i < N - 1;
                ++ i) {
                    if (bins[i].count) l.add(bins[i].b);
                    nl += bins[i].count;
                    left[i] = nl ? l.area() * nl : 0;
                }
                for (int i = N - 1;
                i > 0;
                -- i) {
                    if (bins[i].count) r.add(bins[i].b);
                    nr += bins[i].count;
                    right[i - 1] = nr ? r.area() * nr : 0;
                }
                for (int i = 0;
                i < N - 1;
                ++ i) {
                    float cost = left[i] + right[i] + box.area() * .35f;
                    if (cost < best) {
                        best = cost;
                        axis = ax;
                        binSplit = i;
                    }
                }
            }
            if (axis < 0 && count < 48) return;
            uint32_t mid = first + count / 2;
            if (axis >= 0) {
                float scale = N /(centers.hi[axis] - centers.lo[axis]);
                auto it = std::partition(indices.begin() + first, indices.begin() + first + count, [&](uint32_t i) {
                    return std::clamp(int((bounds[i].center()[axis] - centers.lo[axis]) * scale), 0, N - 1) <= binSplit;
                });
                mid = uint32_t(it - indices.begin());
            }
            if (axis < 0 || mid == first || mid == first + count) {
                V3 d = centers.hi - centers.lo;
                int ax = d.x > d.y ?(d.x > d.z ? 0 : 2) :(d.y > d.z ? 1 : 2);
                mid = first + count / 2;
                std::nth_element(indices.begin() + first, indices.begin() + mid, indices.begin() + first + count, [&](uint32_t a, uint32_t b) {
                    return bounds[a].center()[ax] < bounds[b].center()[ax];
                });
            }
            uint32_t child = uint32_t(nodes.size());
            nodes.resize(nodes.size() + 2);
            nodes[ni].first = child;
            nodes[ni].count = 0;
            split(child, first, mid - first, depth + 1);
            split(child + 1, mid, first + count - mid, depth + 1);
        };
        split(0, 0, uint32_t(indices.size()), 0);
        nodes.shrink_to_fit();
        makeWide();
    }
    void BVH::makeWide() {
        wide.clear();
        if (nodes.empty()) return;
        wide.reserve(nodes.size() / 2 + 1);
        std::function < uint32_t(uint32_t) > emit =[&](uint32_t index) {
            uint32_t result = uint32_t(wide.size());
            wide.emplace_back();
            std::vector < uint32_t > children;
            if (nodes[index].count) children.push_back(index);
            else {
                children.push_back(nodes[index].first);
                children.push_back(nodes[index].first + 1);
            }
            while (children.size() < 4) {
                int best = - 1;
                float area = - 1;
                for (int i = 0;
                i < int(children.size());
                ++ i) {
                    auto & n = nodes[children[i]];
                    float a = Box {
                        n.lo, n.hi
                    }
                    .area();
                    if (! n.count && a > area) {
                        best = i;
                        area = a;
                    }
                }
                if (best < 0) break;
                uint32_t child = nodes[children[size_t(best)]].first;
                children[size_t(best)] = child;
                children.push_back(child + 1);
            }
            WideNode out {
            };
            for (int k = 0;
            k < 4;
            ++ k) {
                if (k < int(children.size())) {
                    auto & n = nodes[children[k]];
                    out.lx[k] = n.lo.x;
                    out.ly[k] = n.lo.y;
                    out.lz[k] = n.lo.z;
                    out.hx[k] = n.hi.x;
                    out.hy[k] = n.hi.y;
                    out.hz[k] = n.hi.z;
                    out.count[k] = n.count;
                    out.first[k] = n.count ? n.first : emit(children[k]);
                } else {
                    out.lx[k] = out.ly[k] = out.lz[k] = Inf;
                    out.hx[k] = out.hy[k] = out.hz[k] = Inf;
                    out.first[k] = 0;
                    out.count[k] = 0;
                }
            }
            wide[result] = out;
            return result;
        };
        emit(0);
        wide.shrink_to_fit();
    }
    void Mesh::build() {
        std::vector < Box > boxes;
        boxes.reserve(faces.size());
        triangles.reserve(faces.size());
        for (uint32_t i = 0;
        i < faces.size();
        ++ i) {
            const Face & f = faces[i];
            if (f.a >= vertices.size() || f.b >= vertices.size() || f.c >= vertices.size()) throw std::runtime_error("Invalid triangle index");
            V3 a = vertices[f.a].p, b = vertices[f.b].p, c = vertices[f.c].p;
            Tri t {
                a, b - a, c - a, i
            };
            if (length2(cross(t.e1, t.e2)) < 1e-25f) continue;
            Box box;
            box.add(a);
            box.add(b);
            box.add(c);
            box.lo = box.lo - V3(1e-6f);
            box.hi = box.hi + V3(1e-6f);
            bounds.add(box);
            boxes.push_back(box);
            triangles.push_back(t);
        }
        bvh.build(boxes, 4);
        for (auto & n : bvh.wide) for (int slot = 0;
        slot < 4;
        ++ slot) if (n.count[slot]) {
            uint32_t first = n.first[slot], count = n.count[slot];
            n.first[slot] = uint32_t(packets.size());
            n.count[slot] =(count + 3) / 4;
            for (uint32_t offset = 0;
            offset < count;
            offset += 4) {
                TrianglePacket packet {
                };
                for (int lane = 0;
                lane < 4;
                ++ lane) {
                    if (offset + lane >= count) continue;
                    const Tri & t = triangles[bvh.indices[first + offset + lane]];
                    packet.px[lane] = t.p.x;
                    packet.py[lane] = t.p.y;
                    packet.pz[lane] = t.p.z;
                    packet.ax[lane] = t.e1.x;
                    packet.ay[lane] = t.e1.y;
                    packet.az[lane] = t.e1.z;
                    packet.bx[lane] = t.e2.x;
                    packet.by[lane] = t.e2.y;
                    packet.bz[lane] = t.e2.z;
                    packet.face[lane] = t.face;
                }
                packets.push_back(packet);
            }
        }
        triangles.clear();
        triangles.shrink_to_fit();
        bvh.nodes.clear();
        bvh.nodes.shrink_to_fit();
    }
    void Scene::load(const std::filesystem::path & path) {
        std::ifstream f(path, std::ios::binary);
        if (! f) throw std::runtime_error("Cannot open scene: " + path.string());
        char magic[4];
        readBytes(f, magic, 4);
        uint32_t ver, nm, ni, nc;
        read(f, ver);
        read(f, nm);
        read(f, ni);
        read(f, nc);
        if (std::memcmp(magic, "CYS2", 4) || ver != 2 || nm > 10000 || ni > 10000000 || nc > 256) throw std::runtime_error("Unsupported scene header");
        meshes.resize(nm);
        uint64_t nv = 0, nt = 0;
        for (auto & m : meshes) {
            uint32_t n, nvtx, nface;
            read(f, n);
            read(f, nvtx);
            read(f, nface);
            if (nvtx > 100000000 || nface > 100000000) throw std::runtime_error("Scene array exceeds safety limit");
            m.name = readString(f, n);
            m.vertices.resize(nvtx);
            m.faces.resize(nface);
            readBytes(f, m.vertices.data(), m.vertices.size() * sizeof(Vertex));
            readBytes(f, m.faces.data(), m.faces.size() * sizeof(Face));
            m.build();
            nv += nvtx;
            nt += nface;
        }
        instances.resize(ni);
        std::vector < Box > boxes;
        boxes.reserve(ni);
        for (auto & inst : instances) {
            read(f, inst.mesh);
            read(f, inst.transform);
            read(f, inst.inverse);
            read(f, inst.tint);
            if (inst.mesh >= meshes.size()) throw std::runtime_error("Invalid instance reference");
            Box b = meshes[inst.mesh].bounds;
            for (int k = 0;
            k < 8;
            ++ k) inst.bounds.add(inst.transform.point( {
                (k & 1) ? b.hi.x : b.lo.x, (k & 2) ? b.hi.y : b.lo.y, (k & 4) ? b.hi.z : b.lo.z
            }));
            boxes.push_back(inst.bounds);
        }
        tlas.build(boxes, 2);
        cameras.resize(nc);
        for (auto & c : cameras) {
            uint32_t n;
            read(f, n);
            c.name = readString(f, n);
            read(f, c.eye);
            read(f, c.target);
            read(f, c.up);
            read(f, c.fov);
        }
        fingerprint = 1469598103934665603ULL;
        f.clear();
        f.seekg(0);
        std::array < char, 65536 > bytes;
        while (f) {
            f.read(bytes.data(), std::streamsize(bytes.size()));
            for (std::streamsize i = 0;
            i < f.gcount();
            ++ i) {
                fingerprint ^= uint8_t(bytes[size_t(i)]);
                fingerprint *= 1099511628211ULL;
            }
        }
        std::cout << "SCENE meshes=" << nm << " instances=" << ni << " vertices=" << nv << " unique_triangles=" << nt << " tlas_nodes=" << tlas.nodes.size() << std::endl;
    }
    bool Scene::intersect(const Ray & ray, Hit & hit, const BVH* visibilityTree) const {
        const BVH& tree=visibilityTree?*visibilityTree:tlas;
        if (tree.wide.empty()) return false;
        StackEntry stack[192];
        int top = 1;
        stack[0] = {
            0, 0, 0
        };
        bool found = false;
        while (top) {
            StackEntry current = stack[-- top];
            if (current.d >= hit.t) continue;
            if (current.count) {
                for (uint32_t k = current.i;
                k < current.i + current.count;
                ++ k) {
                    uint32_t ii = tree.indices[k];
                    const Instance & inst = instances[ii];
                    if (inst.bounds.nearT(ray, hit.t) == Inf) continue;
                    Ray local(inst.inverse.point(ray.o), inst.inverse.vector(ray.d), ray.tmin, std::min(ray.tmax, hit.t));
                    found = meshHit(meshes[inst.mesh], local, hit, ii, false) || found;
                }
            } else {
                const WideNode & node = tree.wide[current.i];
                alignas(16) float ds[4];
                int mask = wideHit(node, ray, hit.t, ds);
                pushHits(node, mask, ds, stack, top);
            }
        }
        return found;
    }
    bool Scene::occluded(const Ray & ray) const {
        if (tlas.wide.empty()) return false;
        StackEntry stack[192];
        int top = 1;
        stack[0] = {
            0, 0, 0
        };
        while (top) {
            StackEntry current = stack[-- top];
            if (current.count) {
                for (uint32_t k = current.i;
                k < current.i + current.count;
                ++ k) {
                    uint32_t ii = tlas.indices[k];
                    const Instance & inst = instances[ii];
                    if (inst.bounds.nearT(ray, ray.tmax) == Inf) continue;
                    Ray local(inst.inverse.point(ray.o), inst.inverse.vector(ray.d), ray.tmin, ray.tmax);
                    Hit h;
                    h.t = ray.tmax;
                    if (meshHit(meshes[inst.mesh], local, h, ii, true)) return true;
                }
            } else {
                const WideNode & node = tlas.wide[current.i];
                alignas(16) float ds[4];
                int mask = wideHit(node, ray, ray.tmax, ds);
                pushHits(node, mask, ds, stack, top);
            }
        }
        return false;
    }
    bool Scene::primitiveHit(const Ray& ray, Hit& hit, uint32_t ii, uint32_t fi) const {
        if (ii >= instances.size()) return false;
        const Instance& instance = instances[ii];
        const Mesh& mesh = meshes[instance.mesh];
        if (fi >= mesh.faces.size()) return false;
        const Face& f = mesh.faces[fi];
        V3 p = mesh.vertices[f.a].p;
        V3 a = mesh.vertices[f.b].p-p, b = mesh.vertices[f.c].p-p;
        TrianglePacket packet{};
        packet.px[0]=p.x;packet.py[0]=p.y;packet.pz[0]=p.z;
        packet.ax[0]=a.x;packet.ay[0]=a.y;packet.az[0]=a.z;
        packet.bx[0]=b.x;packet.by[0]=b.y;packet.bz[0]=b.z;packet.face[0]=fi;
        Ray local(instance.inverse.point(ray.o),instance.inverse.vector(ray.d),ray.tmin,ray.tmax);
        return packetHit(packet,local,hit,ii,false);
    }
    bool Scene::intersectHint(const Ray& ray, Hit& hit, const Hit& hint, const BVH* visibilityTree) const {
        bool candidate=primitiveHit(ray,hit,hint.instance,hint.face);
        // No approximation: the candidate is just an upper bound on traversal.
        bool closer=intersect(ray,hit,visibilityTree);
        return candidate||closer;
    }
    bool Scene::occludedHint(const Ray& ray, Hit& hint) const {
        Hit candidate;
        if (primitiveHit(ray,candidate,hint.instance,hint.face)) {hint=candidate;return true;}
        hint = Hit{};
        if (tlas.wide.empty()) return false;
        StackEntry stack[192];
        int top = 1;
        stack[0] = {
            0, 0, 0
        };
        while (top) {
            StackEntry current = stack[-- top];
            if (current.count) {
                for (uint32_t k = current.i;
                k < current.i + current.count;
                ++ k) {
                    uint32_t ii = tlas.indices[k];
                    const Instance & inst = instances[ii];
                    if (inst.bounds.nearT(ray, ray.tmax) == Inf) continue;
                    Ray local(inst.inverse.point(ray.o), inst.inverse.vector(ray.d), ray.tmin, ray.tmax);
                    Hit h;
                    h.t = ray.tmax;
                    if (meshHit(meshes[inst.mesh], local, h, ii, true)) {hint=h;return true;}
                }
            } else {
                const WideNode & node = tlas.wide[current.i];
                alignas(16) float ds[4];
                int mask = wideHit(node, ray, ray.tmax, ds);
                pushHits(node, mask, ds, stack, top);
            }
        }
        return false;
    }
    Surface Scene::surface(const Ray & ray, const Hit & h) const {
        const Instance & inst = instances[h.instance];
        const Mesh & mesh = meshes[inst.mesh];
        const Face & f = mesh.faces[h.face];
        const Vertex & a = mesh.vertices[f.a], & b = mesh.vertices[f.b], & c = mesh.vertices[f.c];
        float w = 1 - h.u - h.v;
        Surface s;
        s.p = ray.o + ray.d * h.t;
        s.local = a.p * w + b.p * h.u + c.p * h.v;
        s.uv = a.uv * w + b.uv * h.u + c.uv * h.v;
        s.color =(a.color * w + b.color * h.u + c.color * h.v) * inst.tint;
        s.material = f.material;
        V3 e1 = inst.transform.vector(b.p - a.p), e2 = inst.transform.vector(c.p - a.p);
        s.ng = normalize(cross(e1, e2));
        s.n = normalize(inst.inverse.transposeVector(a.n * w + b.n * h.u + c.n * h.v));
        if (dot(s.n, s.ng) < 0) s.n = - s.n;
        if (dot(s.ng, - ray.d) < 0) {
            s.ng = - s.ng;
            s.n = - s.n;
        }
        if (dot(s.n, - ray.d) < .02f) s.n = s.ng;
        float u1 = b.uv.x - a.uv.x, u2 = c.uv.x - a.uv.x, v1 = b.uv.y - a.uv.y, v2 = c.uv.y - a.uv.y, det = u1 * v2 - u2 * v1;
        if (std::abs(det) > 1e-12f) {
            s.tangent = normalize((e1 * v2 - e2 * v1) / det);
            s.bitangent = normalize((e2 * u1 - e1 * u2) / det);
        } else {
            Frame fr(s.n);
            s.tangent = fr.u;
            s.bitangent = fr.v;
        }
        return s;
    }
    Ray Camera::generate(float px, float py, int width, int height, RNG & rng, float aperture, float focus) const {
        V3 fw = normalize(target - eye), r = normalize(cross(fw, up)), v = cross(r, fw);
        float tanf = std::tan(fov * Pi / 360.f);
        float x =(2 * px / float(width) - 1) * tanf * float(width) / float(height), y =(1 - 2 * py / float(height)) * tanf;
        V3 d = normalize(fw + r * x + v * y), origin = eye;
        if (aperture > 0) {
            float a = rng.uniform() * 2 * Pi, rad = std::sqrt(rng.uniform()) * aperture;
            V3 offset = r *(rad * std::cos(a)) + v *(rad * std::sin(a));
            V3 focal = eye + d *(focus / std::max(.01f, dot(d, fw)));
            origin += offset;
            d = normalize(focal - origin);
        }
        return Ray(origin, d);
    }
    void Texture::load(const std::filesystem::path & path) {
        std::ifstream f(path, std::ios::binary);
        if (! f) throw std::runtime_error("Cannot open texture: " + path.string());
        char magic[4];
        uint32_t channels;
        readBytes(f, magic, 4);
        read(f, width);
        read(f, height);
        read(f, channels);
        if (std::memcmp(magic, "CTX1", 4) || channels != 7 || width > 8192 || height > 8192 || width == 0 || height == 0) throw std::runtime_error("Invalid texture");
        pixels.resize(size_t(width) * height);
        readBytes(f, pixels.data(), pixels.size() * sizeof(Texel));
    }
    Texel Texture::sample(float u, float v) const {
        float x = fract(u) * width, y = fract(v) * height;
        int ix = int(x), iy = int(y);
        float fx = x - ix, fy = y - iy;
        const Texel & a = pixels[size_t(iy % int(height)) * width + ix % int(width)], & b = pixels[size_t(iy % int(height)) * width +(ix + 1) % int(width)], & c = pixels[size_t((iy + 1) % int(height)) * width + ix % int(width)], & d = pixels[size_t((iy + 1) % int(height)) * width +(ix + 1) % int(width)];
        Texel t;
        const float * aa = reinterpret_cast < const float * >(& a), * bb = reinterpret_cast < const float * >(& b), * cc = reinterpret_cast < const float * >(& c), * dd = reinterpret_cast < const float * >(& d);
        float * rr = reinterpret_cast < float * >(& t);
        for (int i = 0;
        i < 7;
        ++ i) rr[i] = mix(mix(aa[i], bb[i], fx), mix(cc[i], dd[i], fx), fy);
        return t;
    }
}
