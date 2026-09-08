#pragma once
#include "scene.hpp"
namespace cybr {
    struct BSDF {
        V3 n, ng, wo, R, T;
        float rough = .65f, F0 = .035f, ps = .15f, pt = 0;
        void probabilities();
        float D(V3 h) const;
        float G1(float c) const;
        V3 eval(V3 wi) const;
        float pdf(V3 wi) const;
        V3 sample(RNG & rng) const;
    };
    struct Lighting {
        V3 sun = normalize( {
            .66f, .43f, .62f
        });
        V3 irradiance {
            6.7f, 5.7f, 4.25f
        };
        V3 skyScale {
            .50f, .64f, .83f
        };
        float sunRadius = .00465f;
        float extinction = .0038f, volumeAlbedo = .96f, anisotropy = .58f;
        Box volume {
            {
                - 130, - 3, - 65
            }, {
                130, 40, 190
            }
        };
        V3 sky(V3 d) const;
        float transmittance(const Ray & r) const;
    };
    struct Integrator {
        const Scene & scene;
        Texture bark, soil;
        Lighting lights;
        int maxDepth = 12;
        bool includePrimarySun = true; // Excluded only for uncollided cache hemisphere rays.
        explicit Integrator(const Scene & s) : scene(s) {
        }
        uint64_t transportFingerprint() const;
        BSDF shade(const Surface & s, V3 wo) const;
        V3 trace(Ray ray, RNG & rng) const;
        V3 traceState(Ray ray, RNG & rng, int firstDepth, float initialPdf) const;
    };
    float phaseHG(float cosine, float g);
    V3 sampleHG(RNG & rng, V3 forward, float g);
}
