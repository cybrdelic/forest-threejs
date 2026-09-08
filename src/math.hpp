#pragma once
#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstdint>
#include <limits>
#include <stdexcept>
namespace cybr {
    constexpr float Pi = 3.14159265358979323846f;
    constexpr float Inf = std::numeric_limits < float >::infinity();
    struct V2 {
        float x = 0, y = 0;
        V2 operator +(V2 b) const {
            return {
                x + b.x, y + b.y
            };
        }
        V2 operator *(float s) const {
            return {
                x * s, y * s
            };
        }
    };
    struct V3 {
        float x = 0, y = 0, z = 0;
        constexpr V3() = default;
        constexpr explicit V3(float a) : x(a), y(a), z(a) {
        }
        constexpr V3(float a, float b, float c) : x(a), y(b), z(c) {
        }
        float & operator[](int i) {
            return(& x)[i];
        }
        float operator[](int i) const {
            return(& x)[i];
        }
        V3 operator -() const {
            return {
                - x, - y, - z
            };
        }
        V3 operator +(V3 b) const {
            return {
                x + b.x, y + b.y, z + b.z
            };
        }
        V3 operator -(V3 b) const {
            return {
                x - b.x, y - b.y, z - b.z
            };
        }
        V3 operator *(V3 b) const {
            return {
                x * b.x, y * b.y, z * b.z
            };
        }
        V3 operator /(V3 b) const {
            return {
                x / b.x, y / b.y, z / b.z
            };
        }
        V3 operator *(float s) const {
            return {
                x * s, y * s, z * s
            };
        }
        V3 operator /(float s) const {
            return * this *(1 / s);
        }
        V3 & operator +=(V3 b) {
            x += b.x;
            y += b.y;
            z += b.z;
            return * this;
        }
        V3 & operator *=(V3 b) {
            x *= b.x;
            y *= b.y;
            z *= b.z;
            return * this;
        }
        V3 & operator *=(float s) {
            x *= s;
            y *= s;
            z *= s;
            return * this;
        }
    };
    inline V3 operator *(float s, V3 v) {
        return v * s;
    }
    inline float dot(V3 a, V3 b) {
        return a.x * b.x + a.y * b.y + a.z * b.z;
    }
    inline V3 cross(V3 a, V3 b) {
        return {
            a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x
        };
    }
    inline float length2(V3 a) {
        return dot(a, a);
    }
    inline float length(V3 a) {
        return std::sqrt(length2(a));
    }
    inline V3 normalize(V3 a) {
        float l = length2(a);
        return l > 1e-30f ? a / std::sqrt(l) : V3(0, 1, 0);
    }
    inline float maxc(V3 a) {
        return std::max( {
            a.x, a.y, a.z
        });
    }
    inline V3 minv(V3 a, V3 b) {
        return {
            std::min(a.x, b.x), std::min(a.y, b.y), std::min(a.z, b.z)
        };
    }
    inline V3 maxv(V3 a, V3 b) {
        return {
            std::max(a.x, b.x), std::max(a.y, b.y), std::max(a.z, b.z)
        };
    }
    inline float luminance(V3 a) {
        return .2126f * a.x + .7152f * a.y + .0722f * a.z;
    }
    inline float clamp(float x, float a = 0, float b = 1) {
        return std::clamp(x, a, b);
    }
    inline V3 clamp(V3 a, float lo = 0, float hi = 1) {
        return {
            clamp(a.x, lo, hi), clamp(a.y, lo, hi), clamp(a.z, lo, hi)
        };
    }
    inline float mix(float a, float b, float t) {
        return a +(b - a) * t;
    }
    inline V3 mix(V3 a, V3 b, float t) {
        return a +(b - a) * t;
    }
    inline bool finite(V3 a) {
        return std::isfinite(a.x) && std::isfinite(a.y) && std::isfinite(a.z);
    }
    inline float sqr(float a) {
        return a * a;
    }
    inline float fract(float a) {
        return a - std::floor(a);
    }
    inline uint64_t hash64(uint64_t x) {
        x += 0x9e3779b97f4a7c15ULL;
        x =(x ^(x >> 30)) * 0xbf58476d1ce4e5b9ULL;
        x =(x ^(x >> 27)) * 0x94d049bb133111ebULL;
        return x ^(x >> 31);
    }
    class RNG {
        uint64_t state;
        public : explicit RNG(uint64_t seed) : state(hash64(seed)) {
        }
        uint32_t next() {
            uint64_t old = state;
            state = old * 6364136223846793005ULL + 1442695040888963407ULL;
            uint32_t x = uint32_t(((old >> 18) ^ old) >> 27), r = uint32_t(old >> 59);
            return(x >> r) |(x <<((- r) & 31));
        }
        float uniform() {
            return(float(next() >> 8) + .5f) *(1.0f / 16777216.0f);
        }
    };
    struct Frame {
        V3 u, v, n;
        explicit Frame(V3 normal) : n(normal) {
            // Duff et al.'s branch-stable orthonormal construction.
            float s = std::copysign(1.0f, n.z), a = - 1 /(s + n.z), b = n.x * n.y * a;
            u = {
                1 + s * n.x * n.x * a, s * b, - s * n.x
            };
            v = {
                b, s + n.y * n.y * a, - n.y
            };
        }
        V3 toWorld(V3 w) const {
            return u * w.x + v * w.y + n * w.z;
        }
        V3 toLocal(V3 w) const {
            return {
                dot(w, u), dot(w, v), dot(w, n)
            };
        }
    };
    inline V3 cosine(RNG & r, V3 n) {
        float a = 2 * Pi * r.uniform(), r2 = r.uniform(), s = std::sqrt(r2);
        return Frame(n).toWorld( {
            s * std::cos(a), s * std::sin(a), std::sqrt(1 - r2)
        });
    }
    inline V3 uniformHemisphere(RNG & r) {
        float y = r.uniform(), p = 2 * Pi * r.uniform(), s = std::sqrt(1 - y * y);
        return {
            s * std::cos(p), y, s * std::sin(p)
        };
    }
    inline V3 cone(RNG & r, V3 n, float cosAngle) {
        float c = mix(cosAngle, 1, r.uniform()), p = 2 * Pi * r.uniform(), s = std::sqrt(std::max(0.f, 1 - c * c));
        return Frame(n).toWorld( {
            s * std::cos(p), s * std::sin(p), c
        });
    }
    inline float powerHeuristic(float p, float q) {
        return p * p /(p * p + q * q + 1e-30f);
    }
    struct Ray {
        V3 o, d, inv;
        float tmin = 1e-4f, tmax = Inf;
        // Conservative ray-cone diameter, in metres and radians. Visibility is unchanged.
        float coneWidth = 0, coneSpread = 0;
        Ray() = default;
        Ray(V3 O, V3 D, float minT = 1e-4f, float maxT = Inf) : o(O), d(D), tmin(minT), tmax(maxT) {
            for (int i = 0;
            i < 3;
            ++ i) inv[i] = std::abs(d[i]) > 1e-30f ? 1 / d[i] : std::copysign(1e30f, d[i]);
        }
    };
    struct Box {
        V3 lo {
            Inf
        }, hi {
            - Inf
        };
        void add(V3 p) {
            lo = minv(lo, p);
            hi = maxv(hi, p);
        }
        void add(const Box & b) {
            lo = minv(lo, b.lo);
            hi = maxv(hi, b.hi);
        }
        V3 center() const {
            return(lo + hi) * .5f;
        }
        float area() const {
            V3 d = maxv(hi - lo, V3(0));
            return 2 *(d.x * d.y + d.y * d.z + d.z * d.x);
        }
        float nearT(const Ray & r, float maxT) const {
            V3 a =(lo - r.o) * r.inv, b =(hi - r.o) * r.inv;
            V3 l = minv(a, b), h = maxv(a, b);
            float mn = std::max( {
                l.x, l.y, l.z, r.tmin
            }), mx = std::min( {
                h.x, h.y, h.z, maxT
            });
            return mn <= mx ? mn : Inf;
        }
        bool interval(const Ray & r, float & begin, float & end) const {
            V3 a =(lo - r.o) * r.inv, b =(hi - r.o) * r.inv, l = minv(a, b), h = maxv(a, b);
            begin = std::max( {
                l.x, l.y, l.z, 0.f
            });
            end = std::min( {
                h.x, h.y, h.z, r.tmax
            });
            return end > begin;
        }
    };
    struct Affine {
        std::array < float, 12 > m {
        };
        V3 vector(V3 a) const {
            return {
                m[0] * a.x + m[1] * a.y + m[2] * a.z, m[4] * a.x + m[5] * a.y + m[6] * a.z, m[8] * a.x + m[9] * a.y + m[10] * a.z
            };
        }
        V3 point(V3 a) const {
            return vector(a) + V3(m[3], m[7], m[11]);
        }
        V3 transposeVector(V3 a) const {
            return {
                m[0] * a.x + m[4] * a.y + m[8] * a.z, m[1] * a.x + m[5] * a.y + m[9] * a.z, m[2] * a.x + m[6] * a.y + m[10] * a.z
            };
        }
    };
}
