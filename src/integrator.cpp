#include "integrator.hpp"
#include "build_fingerprint.hpp"
namespace cybr {
    namespace {
        float noiseHash(int a, int b, int c) {
            return float(hash64(uint64_t(uint32_t(a)) * 0x9e3779b1u ^ uint64_t(uint32_t(b)) * 0x85ebca77u ^ uint64_t(uint32_t(c)) * 0xc2b2ae3du) >> 40) *(1.f / 16777216.f);
        }
        float noise(V3 p) {
            int x = int(std::floor(p.x)), y = int(std::floor(p.y)), z = int(std::floor(p.z));
            V3 t {
                p.x - x, p.y - y, p.z - z
            };
            t = t * t *(V3(3) - t * 2);
            return mix(mix(mix(noiseHash(x, y, z), noiseHash(x + 1, y, z), t.x), mix(noiseHash(x, y + 1, z), noiseHash(x + 1, y + 1, z), t.x), t.y), mix(mix(noiseHash(x, y, z + 1), noiseHash(x + 1, y, z + 1), t.x), mix(noiseHash(x, y + 1, z + 1), noiseHash(x + 1, y + 1, z + 1), t.x), t.y), t.z);
        }
        V3 offset(V3 p, V3 ng, V3 d) {
            return p + ng *(dot(ng, d) > 0 ? 1.8e-4f : - 1.8e-4f);
        }
        float fresnel(float c, float f0) {
            float x = 1 - clamp(c), x2 = x * x;
            return f0 +(1 - f0) * x2 * x2 * x;
        }
    }
    void BSDF::probabilities() {
        float r = std::max(0.f, luminance(R)), t = std::max(0.f, luminance(T)), sum = r + t + .07f;
        ps = .07f / sum;
        pt = t / sum;
    }
    float BSDF::D(V3 h) const {
        float alpha = std::max(.035f, rough * rough), a2 = alpha * alpha, c = std::max(0.f, dot(n, h)), den = c * c *(a2 - 1) + 1;
        return a2 /(Pi * den * den);
    }
    float BSDF::G1(float c) const {
        if (c <= 0) return 0;
        float a = std::max(.035f, rough * rough);
        return 2 * c /(c + std::sqrt(a * a +(1 - a * a) * c * c));
    }
    V3 BSDF::eval(V3 wi) const {
        float ci = dot(n, wi), co = dot(n, wo), cg = dot(ng, wi);
        if (co <= 0 || ci * cg <= 0) return {
        };
        if (ci < 0) return T *((1 - F0) / Pi);
        V3 h = normalize(wi + wo);
        float F = fresnel(dot(wo, h), F0), spec = D(h) * G1(ci) * G1(co) * F / std::max(1e-9f, 4 * ci * co);
        return R *((1 - F) / Pi) + V3(spec);
    }
    float BSDF::pdf(V3 wi) const {
        float ci = dot(n, wi), co = dot(n, wo);
        if (ci < 0) return pt *(- ci) / Pi;
        float d =(1 - ps - pt) * ci / Pi;
        if (ci > 0 && co > 0) {
            V3 h = normalize(wo + wi);
            d += ps * D(h) * G1(co) /(4 * co);
        }
        return d;
    }
    V3 BSDF::sample(RNG & rng) const {
        float u = rng.uniform();
        if (u < pt) return cosine(rng, - n);
        if (u >= pt + ps) return cosine(rng, n);
        // Isotropic GGX visible-normal sampling, followed by specular reflection.
        Frame fr(n);
        V3 V = fr.toLocal(wo);
        float a = std::max(.035f, rough * rough);
        V3 vh = normalize( {
            a * V.x, a * V.y, V.z
        });
        float lensq = vh.x * vh.x + vh.y * vh.y;
        V3 t1 = lensq > 0 ? V3(- vh.y, vh.x, 0) / std::sqrt(lensq) : V3(1, 0, 0), t2 = cross(vh, t1);
        float r = std::sqrt(rng.uniform()), phi = 2 * Pi * rng.uniform(), p1 = r * std::cos(phi), p2 = r * std::sin(phi), s = .5f *(1 + vh.z);
        p2 =(1 - s) * std::sqrt(std::max(0.f, 1 - p1 * p1)) + s * p2;
        V3 nh = t1 * p1 + t2 * p2 + vh * std::sqrt(std::max(0.f, 1 - p1 * p1 - p2 * p2));
        V3 h = fr.toWorld(normalize( {
            a * nh.x, a * nh.y, std::max(0.f, nh.z)
        }));
        V3 wi = h *(2 * dot(wo, h)) - wo;
        if (dot(n, wi) <= 0) return V3(0);
        return normalize(wi);
    }
    V3 Lighting::sky(V3 d) const {
        if (d.y <= 0) return {
        };
        // Explicit analytic environment, not a pre-rendered backdrop or image.
        // Horizon / zenith colours are art-directed radiances, not a full atmosphere solve.
        float h = std::pow(clamp(d.y), .55f);
        return skyScale * mix(V3(1.25f, 1.1f, .9f), V3(.62f, .78f, 1), h);
    }
    float Lighting::transmittance(const Ray & r) const {
        if (extinction <= 0) return 1;
        float a, b;
        if (! volume.interval(r, a, b)) return 1;
        return std::exp(- extinction *(b - a));
    }
    float phaseHG(float c, float g) {
        float d = 1 + g * g - 2 * g * c;
        return(1 - g * g) /(4 * Pi * d * std::sqrt(d));
    }
    V3 sampleHG(RNG & rng, V3 forward, float g) {
        float u = rng.uniform(), c;
        if (std::abs(g) < 1e-3f) c = 1 - 2 * u;
        else {
            float v =(1 - g * g) /(1 - g + 2 * g * u);
            c =(1 + g * g - v * v) /(2 * g);
        }
        c = clamp(c, - 1, 1);
        float p = 2 * Pi * rng.uniform(), s = std::sqrt(std::max(0.f, 1 - c * c));
        return Frame(forward).toWorld( {
            s * std::cos(p), s * std::sin(p), c
        });
    }
    uint64_t Integrator::transportFingerprint() const {
        uint64_t h=hash64(BuildFingerprint)^hash64(scene.fingerprint)^hash64(bark.fingerprint)^hash64(soil.fingerprint+1);
        auto add=[&](float f){h=hash64(h^std::bit_cast<uint32_t>(f));};
        for(V3 v:{lights.sun,lights.irradiance,lights.skyScale,lights.volume.lo,lights.volume.hi})
            for(int i=0;i<3;i++)add(v[i]);
        for(float f:{lights.sunRadius,lights.extinction,lights.volumeAlbedo,lights.anisotropy})add(f);
        h=hash64(h^uint64_t(maxDepth));return hash64(h^uint64_t(includePrimarySun));
    }
    BSDF Integrator::shade(const Surface & s, V3 wo) const {
        BSDF b;
        b.n = s.n;
        b.ng = s.ng;
        b.wo = wo;
        b.R = s.color;
        b.T = {
        };
        b.rough = .8f;
        V3 bumped = s.n;
        if (s.material == 1) {
            if (s.color.y > s.color.x * 1.12f) {
                b.R = s.color;
                b.rough = .68f;
            } else {
                Texel t = bark.sample(s.uv.x / 1.65f, s.uv.y / 3.5f, std::max(s.uvFootprint.x/1.65f,s.uvFootprint.y/3.5f));
                b.R = t.color *(s.color / V3(.22f, .18f, .126f));
                b.rough = t.rough;
                bumped = normalize(s.n - s.tangent * clamp(t.du, - 1.0f, 1.0f) - s.bitangent * clamp(t.dv, - .8f, .8f));
                float wet = clamp((1.0f - s.local.y) * .32f, 0, .26f);
                b.R *= 1 - wet;
                // Basal moss depends on world-position field, not shadow/AO baking.
                if (s.p.y < 3.2f) {
                    float m = clamp((noise(s.p * 3.1f) - .49f) * 2.8f) * clamp((2.3f - s.p.y) * .45f);
                    b.R = mix(b.R, V3(.056f, .074f, .018f), m * .75f);
                }
            }
        } else if (s.material == 0) {
            Texel t = soil.sample(s.p.x / 3.f, s.p.z / 3.f, s.footprint / 3.f);
            b.R = t.color;
            b.rough = t.rough;
            Frame frame(s.n);
            V3 tx = normalize(V3(1, 0, 0) - s.n * dot(s.n, V3(1, 0, 0))), tz = normalize(cross(tx, s.n));
            bumped = normalize(s.n - tx * clamp(t.du, - .6f, .6f) - tz * clamp(t.dv, - .6f, .6f));
        } else if (s.material == 2 || s.material == 3 || s.material == 4) {
            float u = s.uv.x - .5f, v = s.uv.y, mid = std::exp(- sqr(u / .012f));
            float veins = std::pow(std::max(0.f, std::cos((v - std::abs(u) * .6f) * 2 * Pi * 11)), 20.f);
            b.R = s.color *(1.05f + .08f * veins) + V3(.04f, .05f, .009f) * mid;
            b.T = s.color * V3(.61f, .85f, .48f);
            b.F0 = .028f;
            b.rough = s.material == 4 ? .64f : .48f;
            float slope = .032f * std::sin(v * 72 - std::abs(u) * 38) +(u > 0 ? .08f : - .08f) * std::exp(- sqr(u / .12f));
            bumped = normalize(s.n + s.tangent * slope + s.bitangent *(.025f * std::cos(v * 55)));
        } else if (s.material == 5) {
            Texel t = soil.sample((s.p.x + s.p.z * .27f) / 1.1f, (s.p.z + s.p.y * .5f) / 1.1f, s.footprint*1.4f/1.1f);
            float patch = t.height;
            float moss = clamp((s.n.y * .45f + patch - .58f) * 2.8f);
            b.R = mix(V3(.145f, .15f, .125f) *(.7f + .8f * patch), V3(.058f, .08f, .023f), moss);
            b.rough = .9f;
            bumped = normalize(s.n - s.tangent * t.du * .7f - s.bitangent * t.dv * .7f);
        } else if (s.material == 6) {
            float fold = std::abs(s.uv.x - .5f);
            b.R = s.color *(.76f + .32f * std::sin(s.uv.y * 12 + fold * 25));
            b.T = s.color * .11f;
            b.rough = .81f;
        } else if (s.material == 7) {
            float rad = std::sqrt(s.uv.x * s.uv.x + s.uv.y * s.uv.y);
            float rings = .7f + .3f * std::sin(rad * 180 + 3 * std::sin(s.uv.x * 15));
            b.R = V3(.28f, .17f, .067f) * rings;
            b.rough = .87f;
        }
        // Keep the shading normal on its geometric side; no shading-normal light leaks.
        if (dot(bumped, s.ng) > .28f && dot(bumped, wo) > .035f) b.n = bumped;
        b.R = clamp(b.R, 0, .72f);
        b.T = clamp(b.T, 0, .42f);
        V3 sum = b.R + b.T;
        float mx = maxc(sum);
        if (mx > .87f) {
            b.R *= .87f / mx;
            b.T *= .87f / mx;
        }
        b.probabilities();
        return b;
    }
    V3 Integrator::trace(Ray ray, RNG & rng) const {
        return traceState(ray, rng, 0, 0);
    }
    V3 Integrator::traceState(Ray ray, RNG & rng, int firstDepth, float initialPdf) const {
        V3 radiance {
        }, throughput {
            1
        };
        float previousPdf = initialPdf;
        const float cosSun = std::cos(lights.sunRadius), omega = 2 * Pi *(1 - cosSun), sunPdf = 1 / omega, skyPdf = 1 /(2 * Pi);
        const V3 solarRadiance = lights.irradiance / omega;
        for (int depth = firstDepth;
        depth < maxDepth;
        ++ depth) {
            Hit hit;
            bool found = scene.intersect(ray, hit);
            // Survival-biased splitting: retain the attenuated surface path and
            // separately estimate the volume source integral. This removes the
            // high variance caused by randomly deleting primary surface samples.
            // Truncated-exponential free-flight sampling has the exact weight
            // albedo*(1-Tr). The additional HG continuation is Russian-rouletted,
            // not omitted: indirect and multiple volume scattering remain active.
            bool volumeEvent = false;
            if (depth > 0 && lights.extinction > 0) {
                float a, z;
                if (lights.volume.interval(ray, a, z)) {
                    float distance = std::min(z, hit.t) - a;
                    if (distance > 0) {
                        float free = - std::log(1 - rng.uniform()) / lights.extinction;
                        if (free < distance) {
                            V3 p = ray.o + ray.d *(a + free);
                            throughput *= lights.volumeAlbedo;
                            V3 ds = cone(rng, lights.sun, cosSun);
                            float ph = phaseHG(dot(ray.d, ds), lights.anisotropy);
                            Ray shadow(p, ds);
                            if (! scene.occluded(shadow)) radiance += throughput * lights.irradiance *(ph * lights.transmittance(shadow) * powerHeuristic(sunPdf, ph));
                            V3 dk = uniformHemisphere(rng);
                            float pk = phaseHG(dot(ray.d, dk), lights.anisotropy);
                            Ray skyRay(p, dk);
                            if (! scene.occluded(skyRay)) radiance += throughput * lights.sky(dk) *(pk * lights.transmittance(skyRay) * powerHeuristic(skyPdf, pk) / skyPdf);
                            V3 wi = sampleHG(rng, ray.d, lights.anisotropy);
                            previousPdf = phaseHG(dot(ray.d, wi), lights.anisotropy);
                            ray = Ray(p, wi);
                            volumeEvent = true;
                        }
                    }
                }
            }
            if (volumeEvent) {
                if (depth >= 2) {
                    float survival = clamp(maxc(throughput), .06f, .95f);
                    if (rng.uniform() > survival) break;
                    throughput *= 1 / survival;
                }
                continue;
            }
            if (depth == 0 && lights.extinction > 0) {
                float a, z;
                if (lights.volume.interval(ray, a, z)) {
                    float distance = std::min(z, hit.t) - a;
                    if (distance > 0) {
                        float Tr = std::exp(- lights.extinction * distance), scatterWeight = lights.volumeAlbedo *(1 - Tr);
                        float free = - std::log(1 - rng.uniform() *(1 - Tr)) / lights.extinction;
                        V3 p = ray.o + ray.d *(a + free);
                        V3 source {
                        };
                        V3 ds = cone(rng, lights.sun, cosSun);
                        float ph = phaseHG(dot(ray.d, ds), lights.anisotropy);
                        Ray shadow(p, ds);
                        if (! scene.occluded(shadow)) source += lights.irradiance *(ph * lights.transmittance(shadow) * powerHeuristic(sunPdf, ph));
                        V3 dk = uniformHemisphere(rng);
                        float pk = phaseHG(dot(ray.d, dk), lights.anisotropy);
                        Ray skyRay(p, dk);
                        if (! scene.occluded(skyRay)) source += lights.sky(dk) *(pk * lights.transmittance(skyRay) * powerHeuristic(skyPdf, pk) / skyPdf);
                        float continueProbability = clamp(scatterWeight * .65f, .015f, .35f);
                        if (depth + 1 < maxDepth && rng.uniform() < continueProbability) {
                            V3 wi = sampleHG(rng, ray.d, lights.anisotropy);
                            float phasePdf = phaseHG(dot(ray.d, wi), lights.anisotropy);
                            source += traceState(Ray(p, wi), rng, depth + 1, phasePdf) / continueProbability;
                        }
                        radiance += throughput * source * scatterWeight;
                        throughput *= Tr;
                    }
                }
            }
            if (! found) {
                float envPdf = ray.d.y > 0 ? skyPdf : 0;
                float weight = depth ? powerHeuristic(previousPdf, envPdf) : 1;
                radiance += throughput * lights.sky(ray.d) * weight;
                if ((depth > 0 || includePrimarySun) && dot(ray.d, lights.sun) >= cosSun) radiance += throughput * solarRadiance *(depth ? powerHeuristic(previousPdf, sunPdf) : 1);
                break;
            }
            Surface surface = scene.surface(ray, hit);
            BSDF b = shade(surface, - ray.d);
            V3 ds = cone(rng, lights.sun, cosSun), fs = b.eval(ds);
            if (maxc(fs) > 0) {
                Ray shadow(offset(surface.p, surface.ng, ds), ds);
                if (! scene.occluded(shadow)) radiance += throughput * fs * lights.irradiance *(std::abs(dot(b.n, ds)) * lights.transmittance(shadow) * powerHeuristic(sunPdf, b.pdf(ds)));
            }
            V3 dk = uniformHemisphere(rng), fk = b.eval(dk);
            if (maxc(fk) > 0) {
                Ray shadow(offset(surface.p, surface.ng, dk), dk);
                if (! scene.occluded(shadow)) radiance += throughput * fk * lights.sky(dk) *(std::abs(dot(b.n, dk)) * lights.transmittance(shadow) * powerHeuristic(skyPdf, b.pdf(dk)) / skyPdf);
            }
            V3 wi = b.sample(rng);
            if (length2(wi) < .5f) break;
            float pdf = b.pdf(wi);
            if (pdf < 1e-12f) break;
            throughput *= b.eval(wi) *(std::abs(dot(b.n, wi)) / pdf);
            previousPdf = pdf;
            const float spread = ray.coneSpread;
            ray = Ray(offset(surface.p, surface.ng, wi), wi);
            // First-hit footprint is retained through secondary bounces; no invented diffuse blur.
            ray.coneWidth = surface.footprint;ray.coneSpread = spread;
            if (! finite(throughput) || maxc(throughput) <= 0) break;
            if (depth >= 2) {
                float survival = clamp(maxc(throughput), .06f, .95f);
                if (rng.uniform() > survival) break;
                throughput *= 1 / survival;
            }
        }
        return radiance;
    }
}
