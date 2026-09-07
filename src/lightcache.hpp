#pragma once
#include "cinema.hpp"
namespace cybr::cinema {
// Spatial irradiance interpolation is a biased approximation. This cache is
// actual sampled light transport, not an image, but does not certify convergence.
struct CacheKey {
    int32_t x=0,y=0,z=0; uint32_t group=0,axis=0;
    bool operator==(const CacheKey&) const=default;
};
struct KeyHash {
    size_t operator()(const CacheKey& k) const {
        uint64_t h=hash64(uint32_t(k.x));h=hash64(h^uint32_t(k.y));h=hash64(h^uint32_t(k.z));
        return hash64(h^(k.group*11+k.axis));
    }
};
struct RunningRadiance {
    V3 mean{};float m2=0;uint32_t n=0;
    void add(V3 v){float old=luminance(mean);++n;mean+=(v-mean)/float(n);m2+=(luminance(v)-old)*(luminance(v)-luminance(mean));}
    float standardError()const{return n>1?std::sqrt(std::max(0.f,m2)/float(n-1)/float(n)):Inf;}
};
struct IrradianceRecord {CacheKey key;V3 p,n;RunningRadiance front,back;uint32_t twoSided=0;};
static_assert(sizeof(IrradianceRecord)==88);
struct CacheResult {V3 front{},back{};float weight=0;};
struct IrradianceCache {
    float cell=1.0f;
    std::vector<IrradianceRecord> records;
    std::unordered_map<CacheKey,uint32_t,KeyHash> index;
    // Exact alternative key storage; no irradiance values are changed.
    std::vector<int32_t> denseIndex;
    int32_t denseX=0,denseY=0,denseZ=0;
    uint32_t denseNX=0,denseNY=0,denseNZ=0;
    void buildDenseIndex();
    int64_t findRecord(CacheKey key)const;
    uint64_t fingerprint=0;
    static uint32_t group(uint32_t material);
    static uint32_t axis(V3 n);
    CacheKey key(V3 p,V3 n,uint32_t material)const;
    void add(const Surface& surface);
    void gather(const Integrator& in,int first,int last,int cameraSteps,int threads);
    void build(const Integrator& in,int minSamples,int maxSamples,float relativeTarget,int threads,const std::filesystem::path& checkpoint,bool footprintAware=true);
    CacheResult lookup(V3 p,V3 n,uint32_t material)const;
    void save(const std::filesystem::path& path)const;
    void load(const std::filesystem::path& path,uint64_t expected);
    void report(const std::filesystem::path& path)const;
};
struct VolumeGrid {
    V3 lo{-45,-3,-24},hi{45,38,115};float spacing=.65f;
    int nx=0,ny=0,nz=0;std::vector<float> solar;
    int ax=0,ay=0,az=0;std::vector<V3> ambient;
    uint64_t fingerprint=0;
    void build(const Integrator& in,int threads);
    float sun(V3 p)const;
    V3 indirect(V3 p)const;
    void save(const std::filesystem::path& path)const;
    void load(const std::filesystem::path& path,uint64_t expected);
};
struct FrustumFog {
    int w,h,steps;float step,maxDistance;std::vector<V3> integral;
    FrustumFog(const Camera& camera,int width,int height,const VolumeGrid& grid,const Lighting& light,int threads);
    V3 sample(float px,float py,float distance,int width,int height)const;
};
} // namespace cybr::cinema
