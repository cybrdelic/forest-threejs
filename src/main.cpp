#include "integrator.hpp"
#include "cinema.hpp"
#include <atomic>
#include <chrono>
#include <cstdio>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <sstream>
#include <csignal>
#include <thread>
namespace cybr {
    volatile std::sig_atomic_t interrupted = 0;
    void interruptHandler(int) {
        interrupted = 1;
    }
    struct Options {
        std::filesystem::path scene, assets, out = "render";
        int width = 960, height = 540, samples = 256, batch = 32, threads = 5, depth = 12, camera = 4;
        int shot = - 1, frame = 0, frames = 1, sequence = 0, filmShot = -1;
        uint64_t seed = 931717;
        float aperture = .0022f, focus = 10.f, exposure = 1.25f, fog = .0038f;
        bool resume = false, test = false, gbuffer = true;
    };
    struct Pixel {
        V3 mean;
        float m2 = 0;
        uint32_t n = 0;
    };
    struct Film {
        int width, height;
        std::vector < Pixel > pixels;
        Film(int w, int h) : width(w), height(h), pixels(size_t(w) * h) {
        }
        void add(size_t i, V3 value) {
            Pixel & p = pixels[i];
            float before = luminance(p.mean);
            ++ p.n;
            p.mean +=(value - p.mean) / float(p.n);
            p.m2 +=(luminance(value) - before) *(luminance(value) - luminance(p.mean));
        }
    };
    float encode(float v, float exposure) {
        v = std::max(0.f, v * exposure);
        v = clamp(v *(2.51f * v + .03f) /(v *(2.43f * v + .59f) + .14f));
        return v <= .0031308f ? 12.92f * v : 1.055f * std::pow(v, 1 / 2.4f) - .055f;
    }
    void ppm(const Film & film, const std::filesystem::path & path, float exposure) {
        std::ofstream f(path, std::ios::binary);
        if (! f) throw std::runtime_error("Cannot write " + path.string());
        f << "P6\n" << film.width << ' ' << film.height << "\n255\n";
        for (const auto & p : film.pixels) {
            unsigned char c[3];
            for (int k = 0;
            k < 3;
            ++ k) c[k] = static_cast < unsigned char >(clamp(encode(p.mean[k], exposure)) * 255 + .5f);
            f.write(reinterpret_cast < const char * >(c), 3);
        }
        if (! f) throw std::runtime_error("PPM write failed");
    }
    void pfm(const Film & film, const std::filesystem::path & path) {
        std::ofstream f(path, std::ios::binary);
        if (! f) throw std::runtime_error("Cannot write PFM");
        f << "PF\n" << film.width << ' ' << film.height << "\n-1.0\n";
        for (int y = film.height - 1;
        y >= 0;
        -- y) for (int x = 0;
        x < film.width;
        ++ x) {
            const V3 & c = film.pixels[size_t(y) * film.width + x].mean;
            f.write(reinterpret_cast < const char * >(& c), 12);
        }
    }
    uint64_t signature(const Options & o, const Camera & c, const Scene & s) {
        uint64_t v = hash64(2026090607ULL) ^ s.fingerprint ^ hash64(o.seed) ^ hash64(uint64_t(o.width) << 32 | uint32_t(o.height));
        auto add =[&](float f) {
            v = hash64(v ^ std::bit_cast < uint32_t >(f));
        };
        for (int i = 0;
        i < 3;
        ++ i) {
            add(c.eye[i]);
            add(c.target[i]);
            add(c.up[i]);
        }
        add(c.fov);
        add(o.fog);
        add(o.aperture);
        add(o.focus);
        Lighting light;
        for (int i = 0;
        i < 3;
        ++ i) {
            add(light.sun[i]);
            add(light.irradiance[i]);
            add(light.skyScale[i]);
            add(light.volume.lo[i]);
            add(light.volume.hi[i]);
        }
        add(light.sunRadius);
        add(light.anisotropy);
        add(light.volumeAlbedo);
        v ^= hash64(o.depth);
        return v;
    }
    void checkpoint(const Film & film, const std::filesystem::path & path, uint64_t sig) {
        std::filesystem::path tmp = path;
        tmp += ".tmp";
        std::ofstream f(tmp, std::ios::binary);
        if (! f) throw std::runtime_error("Cannot write checkpoint");
        f.write("CYACC2\0\0", 8);
        f.write(reinterpret_cast < const char * >(& sig), 8);
        uint32_t w = film.width, h = film.height;
        f.write(reinterpret_cast < const char * >(& w), 4);
        f.write(reinterpret_cast < const char * >(& h), 4);
        f.write(reinterpret_cast < const char * >(film.pixels.data()), std::streamsize(film.pixels.size() * sizeof(Pixel)));
        f.close();
        if (! f) throw std::runtime_error("Checkpoint write failed");
        std::error_code ec;
        std::filesystem::rename(tmp, path, ec);
        if (ec) {
            std::filesystem::remove(path, ec);
            std::filesystem::rename(tmp, path);
        }
    }
    void restore(Film & film, const std::filesystem::path & path, uint64_t expected) {
        std::ifstream f(path, std::ios::binary);
        if (! f) throw std::runtime_error("Missing resume checkpoint");
        char magic[8];
        uint64_t sig;
        uint32_t w, h;
        f.read(magic, 8);
        f.read(reinterpret_cast < char * >(& sig), 8);
        f.read(reinterpret_cast < char * >(& w), 4);
        f.read(reinterpret_cast < char * >(& h), 4);
        if (std::string(magic, 6) != "CYACC2" || sig != expected || w != unsigned(film.width) || h != unsigned(film.height)) throw std::runtime_error("Resume scene/camera/integrator signature mismatch");
        f.read(reinterpret_cast < char * >(film.pixels.data()), std::streamsize(film.pixels.size() * sizeof(Pixel)));
        if (! f) throw std::runtime_error("Truncated checkpoint");
    }
    float percentile(std::vector < float > a, float p) {
        if (a.empty()) return 0;
        size_t i = std::min(a.size() - 1, size_t(p *(a.size() - 1)));
        std::nth_element(a.begin(), a.begin() + i, a.end());
        return a[i];
    }
    void stats(const Film & film, const Options & o, double seconds, uint64_t sig) {
        std::vector < float > relative, absolute;
        relative.reserve(film.pixels.size());
        absolute.reserve(film.pixels.size());
        double avg = 0;
        uint64_t bad = 0;
        size_t small = 0;
        for (const auto & p : film.pixels) {
            float L = luminance(p.mean), se = p.n > 1 ? std::sqrt(std::max(0.f, p.m2) / float(p.n - 1) / float(p.n)) : 0;
            float rel = se / std::max(.02f, L);
            relative.push_back(rel);
            absolute.push_back(se);
            avg += L;
            bad += ! finite(p.mean);
            small += 1.96f * rel < .02f;
        }
        std::ofstream f(o.out.string() + ".json");
        f << std::setprecision(9) << "{\n  \"renderer\": \"CYBR Forest native C++20 Monte Carlo path tracer\",\n  \"width\": " << film.width << ", \"height\": " << film.height << ",\n  \"samples_per_pixel\": " << film.pixels.front().n << ",\n  \"max_path_events\": " << o.depth << ",\n  \"russian_roulette_after_event\": 3,\n  \"volume_extinction_per_metre\": " << o.fog << ",\n  \"lens_radius_m\": " << o.aperture << ", \"focus_distance_m\": " << o.focus << ",\n  \"seed\": " << o.seed << ", \"signature\": \"" << sig << "\",\n  \"elapsed_this_invocation_seconds\": " << seconds << ",\n  \"mean_linear_luminance\": " << avg / film.pixels.size() << ",\n  \"raw_luminance_standard_error_median\": " << percentile(absolute, .5f) << ",\n  \"raw_relative_standard_error_median\": " << percentile(relative, .5f) << ",\n  \"raw_relative_standard_error_p95\": " << percentile(relative, .95f) << ",\n  \"fraction_with_estimated_95pct_halfwidth_below_2pct\": " << double(small) / film.pixels.size() << ",\n  \"relative_error_luminance_floor\": 0.02,\n  \"nonfinite_pixels\": " << bad << ",\n  \"denoised\": false,\n  \"convergence_claim\": \"Finite-sample diagnostics only; not certified full convergence. Error estimates do not bound finite-bounce or model bias.\"\n}\n";
    }
    Camera shotCamera(const Scene & scene, const Options & o) {
        if (o.filmShot >= 0) {
            if (o.frames < 1 || o.frame < 0 || o.frame >= o.frames) throw std::runtime_error("Invalid film frame range");
            return cinema::cameraAt(o.filmShot, o.frames > 1 ? float(o.frame) / float(o.frames - 1) : .5f);
        }
        if (o.camera < 0 || o.camera >= int(scene.cameras.size())) throw std::runtime_error("Camera out of range");
        Camera c = scene.cameras[o.camera];
        if (o.shot < 0) return c;
        float t = o.frames > 1 ? float(o.frame) / float(o.frames - 1) : .5f;
        float smooth = t * t *(3 - 2 * t);
        if (o.shot == 0) {
            c = scene.cameras[4];
            c.eye = V3(mix(.30f, - .35f, smooth), mix(1.68f, 1.8f, smooth), mix(- 11.4f, - 8.2f, smooth));
            c.target = V3(.5f, 2.4f, 15);
            c.fov = 49;
        } else if (o.shot == 1) {
            c = scene.cameras[1];
            c.eye = V3(mix(- .95f, .3f, smooth), .86f, mix(- 5.2f, - 3.1f, smooth));
            c.target = V3(- 2.8f, 1.45f, 6.8f);
            c.fov = 47;
        } else if (o.shot == 2) {
            c = scene.cameras[4];
            c.eye = V3(mix(- .7f, .6f, smooth), mix(1.75f, 2.05f, smooth), mix(1.3f, 4.1f, smooth));
            c.target = V3(2.8f, 3.1f, 23);
            c.fov = 47;
        } else throw std::runtime_error("Shot must be 0, 1 or 2");
        return c;
    }
    void gbuffer(const Integrator & integrator, const Camera & cam, const Options & o) {
        Film normal(o.width, o.height), albedo(o.width, o.height), depth(o.width, o.height);
        std::atomic < int > row {
            0
        };
        std::vector < std::thread > threads;
        for (int t = 0;
        t < o.threads;
        ++ t) threads.emplace_back([&] {
            int y;
            while ((y = row.fetch_add(1)) < o.height) for (int x = 0;
            x < o.width;
            ++ x) {
                RNG rng(1);
                Ray ray = cam.generate(float(x) + .5f, float(y) + .5f, o.width, o.height, rng, 0, o.focus);
                Hit h;
                size_t i = size_t(y) * o.width + x;
                if (integrator.scene.intersect(ray, h)) {
                    auto s = integrator.scene.surface(ray, h);
                    auto b = integrator.shade(s, - ray.d);
                    normal.pixels[i].mean = b.n;
                    albedo.pixels[i].mean = b.R;
                    depth.pixels[i].mean = V3(h.t);
                } else {
                    normal.pixels[i].mean = {
                    };
                    albedo.pixels[i].mean = {
                    };
                    depth.pixels[i].mean = V3(1e5f);
                }
            }
        });
        for (auto & t : threads) t.join();
        pfm(normal, o.out.string() + ".normal.pfm");
        pfm(albedo, o.out.string() + ".albedo.pfm");
        pfm(depth, o.out.string() + ".depth.pfm");
    }
    void render(const Scene & scene, const Options & o) {
        Integrator integrator(scene);
        integrator.bark.load(o.assets / "bark.tex");
        integrator.soil.load(o.assets / "soil.tex");
        integrator.maxDepth = o.depth;
        integrator.lights.extinction = o.fog;
        Camera camera = shotCamera(scene, o);
        uint64_t sig = hash64(signature(o, camera, scene) ^ integrator.transportFingerprint());
        Film film(o.width, o.height);
        if (o.resume) restore(film, o.out.string() + ".accum", sig);
        auto start = std::chrono::steady_clock::now();
        uint32_t completed = film.pixels.front().n;
        std::atomic < uint64_t > nonfinite {
            0
        };
        if (o.gbuffer) gbuffer(integrator, camera, o);
        constexpr int Tile = 16;
        int nx =(o.width + Tile - 1) / Tile, ny =(o.height + Tile - 1) / Tile;
        while (completed < unsigned(o.samples) && ! interrupted) {
            uint32_t end = std::min(unsigned(o.samples), completed + unsigned(o.batch));
            std::atomic < int > next {
                0
            };
            std::vector < std::thread > threads;
            for (int t = 0;
            t < o.threads;
            ++ t) threads.emplace_back([&] {
                int ti;
                while ((ti = next.fetch_add(1)) < nx * ny) {
                    int tx = ti % nx, ty = ti / nx;
                    for (int y = ty * Tile;
                    y < std::min(o.height, (ty + 1) * Tile);
                    ++ y) for (int x = tx * Tile;
                    x < std::min(o.width, (tx + 1) * Tile);
                    ++ x) {
                        size_t pi = size_t(y) * o.width + x;
                        for (uint32_t sample = completed;
                        sample < end;
                        ++ sample) {
                            RNG rng(hash64(pi ^ o.seed) ^ hash64(uint64_t(sample) * 0x9e3779b97f4a7c15ULL));
                            float px = float(x) + rng.uniform(), py = float(y) + rng.uniform();
                            Ray ray = camera.generate(px, py, o.width, o.height, rng, o.aperture, o.focus);
                            V3 L = integrator.trace(ray, rng);
                            if (! finite(L)) {
                                ++ nonfinite;
                                L = V3(0);
                            }
                            film.add(pi, L);
                        }
                    }
                }
            });
            for (auto & t : threads) t.join();
            completed = end;
            double seconds = std::chrono::duration < double >(std::chrono::steady_clock::now() - start).count();
            ppm(film, o.out.string() + ".ppm", o.exposure);
            pfm(film, o.out.string() + ".pfm");
            checkpoint(film, o.out.string() + ".accum", sig);
            stats(film, o, seconds, sig);
            std::cout << "PROGRESS spp=" << completed << " / " << o.samples << " seconds=" << std::fixed << std::setprecision(2) << seconds << " nonfinite_samples=" << nonfinite << std::endl;
        }
        if (nonfinite > 0) throw std::runtime_error("Nonfinite radiance sample detected; inspect log");
    }
    int selfTests() {
        int passed = 0;
        auto check =[&](bool ok, const char * name) {
            if (! ok) throw std::runtime_error(std::string("TEST FAILED: ") + name);
            ++ passed;
            std::cout << "PASS " << name << '\n';
        };
        check(std::abs(dot(V3(1, 2, 3), V3(3, 2, 1)) - 10) < 1e-6, "dot product");
        check(length(cross(V3(1, 0, 0), V3(0, 1, 0)) - V3(0, 0, 1)) < 1e-6, "cross product");
        RNG rng(1);
        double u = 0;
        for (int i = 0;
        i < 100000;
        ++ i) u += rng.uniform();
        check(std::abs(u / 100000 - .5) < .005, "PCG uniform mean");
        bool frameOK = true;
        for (int i = 0;
        i < 1000;
        ++ i) {
            V3 n = normalize(V3(rng.uniform() * 2 - 1, rng.uniform() * 2 - 1, rng.uniform() * 2 - 1));
            Frame f(n);
            frameOK &= std::abs(dot(f.u, f.v)) < 1e-5 && std::abs(dot(f.n, f.u)) < 1e-5 && std::abs(length(f.v) - 1) < 1e-5;
        }
        check(frameOK, "orthonormal frame including south pole");
        Frame pole( {
            0, 0, - 1
        });
        check(finite(pole.u) && finite(pole.v), "negative Z pole finite");
        Box box {
            {
                - 1, - 1, - 1
            }, {
                1, 1, 1
            }
        };
        check(std::abs(box.nearT(Ray( {
            0, 0, - 3
        }, {
            0, 0, 1
        }), Inf) - 2) < 1e-6, "parallel slab intersection");
        check(box.nearT(Ray( {
            2, 0, - 3
        }, {
            0, 0, 1
        }), Inf) == Inf, "parallel slab miss");
        Affine affine {
            {
                2, 0, 0, 1, 0, 3, 0, 2, 0, 0, 4, 3
            }
        };
        check(length(affine.point( {
            1, 1, 1
        }) - V3(3, 5, 7)) < 1e-6, "affine point mapping");
        Scene scene;
        Mesh mesh;
        mesh.vertices = {
            {
                {
                    - 2, - 2, 0
                }, {
                    0, 0, 1
                }, {
                    0, 0
                }, {
                    .3f, .3f, .3f
                }
            }, {
                {
                    2, - 2, 0
                }, {
                    0, 0, 1
                }, {
                    1, 0
                }, {
                    .3f, .3f, .3f
                }
            }, {
                {
                    0, 2, 0
                }, {
                    0, 0, 1
                }, {
                    .5f, 1
                }, {
                    .3f, .3f, .3f
                }
            }
        };
        mesh.faces = {
            {
                0, 1, 2, 0
            }
        };
        mesh.build();
        scene.meshes.push_back(std::move(mesh));
        Instance inst;
        inst.transform.m = {
            1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0
        };
        inst.inverse = inst.transform;
        inst.bounds = scene.meshes[0].bounds;
        scene.instances.push_back(inst);
        scene.tlas.build( {
            inst.bounds
        });
        Hit hit;
        check(scene.intersect(Ray( {
            0, 0, - 2
        }, {
            0, 0, 1
        }), hit) && std::abs(hit.t - 2) < 1e-6, "instanced triangle intersection");
        check(scene.occluded(Ray( {
            0, 0, - 2
        }, {
            0, 0, 1
        })), "shadow any hit");
        check(! scene.occluded(Ray( {
            0, 0, - 2
        }, {
            0, 0, 1
        }, 1e-4f, 1)), "finite shadow interval");
        Hit miss;
        check(! scene.intersect(Ray( {
            5, 0, - 2
        }, {
            0, 0, 1
        }), miss), "triangle miss");
        double phaseIntegral = 0, meanCos = 0;
        for (int i = 0;
        i < 200000;
        ++ i) {
            float c = 2 * rng.uniform() - 1;
            phaseIntegral += phaseHG(c, .58f) * 4 * Pi;
            meanCos += dot(sampleHG(rng, {
                0, 1, 0
            }, .58f), V3(0, 1, 0));
        }
        check(std::abs(phaseIntegral / 200000 - 1) < .02, "HG phase normalization");
        check(std::abs(meanCos / 200000 - .58) < .005, "HG sample mean cosine");
        BSDF b;
        b.n = b.ng = b.wo = {
            0, 1, 0
        };
        b.R = V3(.3f);
        b.T = V3(.2f);
        b.probabilities();
        check(b.ps > 0 && b.pt > 0 && b.ps + b.pt < 1, "BSDF sampling mixture");
        double energy = 0;
        bool bsdfFinite = true;
        for (int i = 0;
        i < 100000;
        ++ i) {
            V3 wi = b.sample(rng);
            if (length2(wi) < .5f) continue;
            float p = b.pdf(wi);
            V3 f = b.eval(wi);
            bsdfFinite &= p >= 0 && finite(f);
            if (p > 0) energy += luminance(f) * std::abs(dot(b.n, wi)) / p;
        }
        check(bsdfFinite, "BSDF sample/evaluation finite");
        check(energy / 100000 < .60 && energy / 100000 > .43, "leaf hemispherical energy bound");
        Lighting lights;
        lights.extinction = .01f;
        Ray vr( {
            0, 0, 0
        }, {
            0, 1, 0
        }, 1e-4f, 10);
        check(std::abs(lights.transmittance(vr) - std::exp(- .1f)) < 1e-5, "Beer Lambert medium transmittance");
        check(luminance(lights.sky( {
            0, - 1, 0
        })) == 0, "no below-horizon environment leak");
        Film film(1, 1);
        film.add(0, V3(1));
        film.add(0, V3(3));
        check(std::abs(film.pixels[0].mean.x - 2) < 1e-6 && std::abs(film.pixels[0].m2 - 2) < 1e-5, "Welford mean and variance");
        Camera cam;
        cam.eye = {
            0, 0, - 1
        };
        cam.target = {
            0, 0, 0
        };
        RNG r(2);
        check(length(cam.generate(50, 50, 100, 100, r, 0, 10).d - V3(0, 0, 1)) < 1e-6, "camera centre ray");
        check(std::abs(powerHeuristic(.4f, .2f) + powerHeuristic(.2f, .4f) - 1) < 1e-6, "MIS partition of unity");
        std::cout << "TESTS " << passed << " PASSED\n";
        return 0;
    }
    Options parse(int argc, char * * argv) {
        Options o;
        for (int i = 1;
        i < argc;
        ++ i) {
            std::string a = argv[i];
            auto next =[&]() {
                if (i + 1 >= argc) throw std::runtime_error("Missing value for " + a);
                return std::string(argv[++ i]);
            };
            if (a == "--scene") o.scene = next();
            else if (a == "--assets") o.assets = next();
            else if (a == "--out") o.out = next();
            else if (a == "--width") o.width = std::stoi(next());
            else if (a == "--height") o.height = std::stoi(next());
            else if (a == "--samples") o.samples = std::stoi(next());
            else if (a == "--batch") o.batch = std::stoi(next());
            else if (a == "--threads") o.threads = std::stoi(next());
            else if (a == "--depth") o.depth = std::stoi(next());
            else if (a == "--camera") o.camera = std::stoi(next());
            else if (a == "--shot") o.shot = std::stoi(next());
            else if (a == "--film-shot") o.filmShot = std::stoi(next());
            else if (a == "--frame") o.frame = std::stoi(next());
            else if (a == "--frames") o.frames = std::stoi(next());
            else if (a == "--sequence") o.sequence = std::stoi(next());
            else if (a == "--seed") o.seed = std::stoull(next());
            else if (a == "--aperture") o.aperture = std::stof(next());
            else if (a == "--focus") o.focus = std::stof(next());
            else if (a == "--exposure") o.exposure = std::stof(next());
            else if (a == "--fog") o.fog = std::stof(next());
            else if (a == "--resume") o.resume = true;
            else if (a == "--no-gbuffer") o.gbuffer = false;
            else if (a == "--test") o.test = true;
            else if (a == "--help") {
                std::cout << "cybr-forest --scene assets/forest.cys --assets assets --out renders/hero --width 1280 --height 720 --samples 1024 --batch 64 --threads 5\nOptional: --depth 12 --camera 4 --fog .0038 --aperture .0022 --focus 10 --seed 931717 --resume\nAnimation: --shot 0 --frame 0 --frames 72; twelve-shot film: --film-shot 0..11 --frame 0 --frames 48\nValidation: --test\n";
                std::exit(0);
            } else throw std::runtime_error("Unknown argument: " + a);
        }
        if (o.width < 1 || o.height < 1 || o.width > 16384 || o.height > 16384 || o.samples < 1 || o.samples > 1000000 || o.batch < 1 || o.threads < 1 || o.threads > 128 || o.depth < 1 || o.depth > 128 || o.fog < 0 || o.aperture < 0 || o.focus <= 0 || o.filmShot < -1 || o.filmShot > 11) throw std::runtime_error("Invalid rendering arguments");
        return o;
    }
}
int main(int argc, char * * argv) {
    try {
        std::signal(SIGINT, cybr::interruptHandler);
        auto o = cybr::parse(argc, argv);
        if (o.test) return cybr::selfTests();
        if (o.scene.empty()) throw std::runtime_error("--scene required");
        if (o.assets.empty()) o.assets = o.scene.parent_path();
        if (o.out.has_parent_path()) std::filesystem::create_directories(o.out.parent_path());
        cybr::Scene scene;
        scene.load(o.scene);
        if (o.sequence > 0) {
            auto prefix = o.out;
            o.frames = o.sequence;
            for (int k = 0;
            k < o.sequence;
            ++ k) {
                o.frame = k;
                std::ostringstream suffix;
                suffix << "_" << std::setw(5) << std::setfill('0') << k;
                o.out = prefix.string() + suffix.str();
                o.seed = 931717 + uint64_t(k) * 11939;
                cybr::render(scene, o);
            }
        } else cybr::render(scene, o);
        return 0;
    } catch (const std::exception & e) {
        std::cerr << "ERROR " << e.what() << '\n';
        return 1;
    }
}
