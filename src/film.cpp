#include "lightcache.hpp"
using namespace cybr;
using namespace cybr::cinema;

struct Args {
    std::filesystem::path assets,out;
    std::string mode="scout";
    int w=320,h=180,spp=16,threads=4,first=0,last=11,frames=48;
    int cacheMin=512,cacheMax=4096,cameraSteps=12,startFrame=0,endFrame=-1;
    float cell=1.0f,target=.04f,exposure=2.1f;
    bool resume=false,pfm=false,temporal=true,uniformCache=false,coherence=true,frustum=true;
};
Args parseFilm(int argc,char**argv){
    Args a;
    for(int i=1;i<argc;i++){
        std::string k=argv[i];
        auto next=[&](){if(i+1>=argc)throw std::runtime_error("Missing argument "+k);return std::string(argv[++i]);};
        if(k=="--assets")a.assets=next();
        else if(k=="--out")a.out=next();
        else if(k=="--mode")a.mode=next();
        else if(k=="--width")a.w=std::stoi(next());
        else if(k=="--height")a.h=std::stoi(next());
        else if(k=="--samples")a.spp=std::stoi(next());
        else if(k=="--threads")a.threads=std::stoi(next());
        else if(k=="--first")a.first=std::stoi(next());
        else if(k=="--last")a.last=std::stoi(next());
        else if(k=="--frames")a.frames=std::stoi(next());
        else if(k=="--frame-start")a.startFrame=std::stoi(next());
        else if(k=="--frame-end")a.endFrame=std::stoi(next());
        else if(k=="--cache-min")a.cacheMin=std::stoi(next());
        else if(k=="--cache-max")a.cacheMax=std::stoi(next());
        else if(k=="--camera-steps")a.cameraSteps=std::stoi(next());
        else if(k=="--cell")a.cell=std::stof(next());
        else if(k=="--target")a.target=std::stof(next());
        else if(k=="--exposure")a.exposure=std::stof(next());
        else if(k=="--resume")a.resume=true;
        else if(k=="--pfm")a.pfm=true;
        else if(k=="--no-temporal")a.temporal=false;
        else if(k=="--uniform-cache")a.uniformCache=true;
        else if(k=="--no-coherence")a.coherence=false;
        else if(k=="--no-frustum")a.frustum=false;
        else if(k=="--help"){
            std::cout<<"cybr-film --assets assets --out frames --mode [gather|bake|volume|scout|film|still|reference|uncached-film] "
                     <<"--width 1280 --height 720 --samples 8 --frames 48 --first 0 --last 11 --threads 4\n";
            std::exit(0);
        }else throw std::runtime_error("Unknown argument "+k);
    }
    if(a.assets.empty()||a.out.empty()||a.w<12||a.h<12||a.w>8192||a.h>8192||a.spp<2||a.spp>1000000||a.threads<1||a.threads>128||a.first<0||a.last>11||a.first>a.last||a.frames<1||a.frames>100000||!std::isfinite(a.cell)||a.cell<=0||a.cell>20||a.cacheMin<1||a.cacheMax<a.cacheMin||a.cacheMax>1000000||!std::isfinite(a.target)||a.target<=0||!std::isfinite(a.exposure)||a.exposure<=0||a.cameraSteps<1||a.cameraSteps>1000)
        throw std::runtime_error("Invalid options");
    if(a.resume&&a.temporal&&a.mode=="film")throw std::runtime_error("Temporal renders must restart a complete shot; select --first/--last or use --no-temporal.");
    if(a.endFrame<0)a.endFrame=a.frames;
    if(a.startFrame<0||a.startFrame>=a.endFrame||a.endFrame>a.frames)throw std::runtime_error("Invalid frame interval");
    return a;
}
struct FrameDiagnostics {
    uint64_t cameraSamples=0,cacheLookups=0,cacheMisses=0,nonfinite=0;
    float medianCameraSE=0,p95CameraSE=0,seconds=0,historyAcceptance=0;
    uint32_t cameraInstances=0;
};
float quantile(std::vector<float> values,float q){
    if(values.empty())return 0;
    size_t k=std::min(values.size()-1,size_t(q*(values.size()-1)));
    std::nth_element(values.begin(),values.begin()+k,values.end());return values[k];
}
// Exact primary geometry/direct visibility + an explicitly approximate diffuse
// cache. This is not the independent, uncached reference path integrator.
struct CachedCameraIntegrator {
    const Integrator& reference;
    const IrradianceCache& cache;
    const FrustumFog& fog;
    Integrator fallback;
    int width,height;bool coherent;const BVH* visibilityTree;
    std::array<V3,64> sunDirections;
    CachedCameraIntegrator(const Integrator& in,const IrradianceCache& c,const FrustumFog& f,int w,int h,bool useHints,const BVH* tree)
        :reference(in),cache(c),fog(f),fallback(in.scene),width(w),height(h),coherent(useHints),visibilityTree(tree){
        fallback.bark=in.bark;fallback.soil=in.soil;fallback.lights=in.lights;
        fallback.lights.extinction=0;fallback.includePrimarySun=false;fallback.maxDepth=in.maxDepth;
        Frame frame(in.lights.sun);float cosAngle=std::cos(in.lights.sunRadius);
        for(int k=0;k<64;k++){
            float u=(k+.5f)/64.f,v=radicalInverse(k),co=mix(cosAngle,1,u),si=std::sqrt(std::max(0.f,1-co*co)),p=2*Pi*v;
            sunDirections[k]=frame.toWorld({si*std::cos(p),si*std::sin(p),co});
        }
    }
    V3 shade(const Ray& ray,float px,float py,uint64_t sampleSeed,int sampleIndex,uint64_t& lookups,uint64_t& misses,Hit& primaryHint,Hit& shadowHint)const{
        Hit hit;bool found=coherent?reference.scene.intersectHint(ray,hit,primaryHint,visibilityTree):reference.scene.intersect(ray,hit,visibilityTree);
        primaryHint=hit;
        float distance=found?hit.t:160.f;V3 out{};
        if(found){
            Surface surface=reference.scene.surface(ray,hit);BSDF b=reference.shade(surface,-ray.d);
            CacheResult irradiance=cache.lookup(surface.p,b.n,surface.material);lookups++;
            if(irradiance.weight<=0){
                // Disocclusions not covered by the cache use actual new paths.
                misses++;RNG rng(sampleSeed^hash64(sampleIndex));V3 d=cosine(rng,b.n);
                irradiance.front=fallback.trace(Ray(safeOffset(surface,d),d),rng);
                if(maxc(b.T)>0){d=cosine(rng,-b.n);irradiance.back=fallback.trace(Ray(safeOffset(surface,d),d),rng);}
            }
            out=b.R*(1-b.F0)*irradiance.front+b.T*(1-b.F0)*irradiance.back;
            V3 sun=sunDirections[(sampleIndex+int(sampleSeed&63))&63],f=b.eval(sun);
            if(maxc(f)>0){Ray shadow(safeOffset(surface,sun),sun);
                bool blocked=coherent?reference.scene.occludedHint(shadow,shadowHint):reference.scene.occluded(shadow);
                if(!blocked)out+=f*reference.lights.irradiance*(std::abs(dot(b.n,sun))*reference.lights.transmittance(shadow));
            }
        }else{
            out=reference.lights.sky(ray.d);
            if(dot(ray.d,reference.lights.sun)>=std::cos(reference.lights.sunRadius)){
                float omega=2*Pi*(1-std::cos(reference.lights.sunRadius));out+=reference.lights.irradiance/omega;
            }
        }
        Ray segment=ray;segment.tmax=distance;
        return out*reference.lights.transmittance(segment)+fog.sample(px,py,distance,width,height);
    }
};
void writeFrameReport(const std::filesystem::path& path,const Args&a,int shot,int frame,const Camera&c,const FrameDiagnostics&d,bool cached){
    std::ofstream f(path);if(!f)throw std::runtime_error("Cannot write frame report");
    f<<std::setprecision(9)
     <<"{\n\"shot\":"<<shot<<",\n\"name\":\""<<shots()[shot].name<<"\",\n\"frame\":"<<frame
     <<",\n\"width\":"<<a.w<<",\n\"height\":"<<a.h<<",\n\"camera_samples_per_pixel\":"<<a.spp
     <<",\n\"camera_visible_instances\":"<<d.cameraInstances<<",\n\"conservative_camera_frustum\":"<<(cached&&a.frustum?"true":"false")<<",\n\"camera_samples\":"<<d.cameraSamples<<",\n\"camera_eye\":["<<c.eye.x<<","<<c.eye.y<<","<<c.eye.z
     <<"],\n\"camera_target\":["<<c.target.x<<","<<c.target.y<<","<<c.target.z<<"],\n\"vertical_fov_degrees\":"<<c.fov
     <<",\n\"cached_diffuse_transport\":"<<(cached?"true":"false")<<",\n\"exact_visibility_hints\":"<<(cached&&a.coherence?"true":"false")<<",\n\"error_luminance_floor\":0.03"
     <<",\n\"camera_se_normalized_median\":"<<d.medianCameraSE<<",\n\"camera_se_normalized_p95\":"<<d.p95CameraSE
     <<",\n\"cache_lookups\":"<<d.cacheLookups<<",\n\"cache_misses\":"<<d.cacheMisses
     <<",\n\"nonfinite_samples\":"<<d.nonfinite<<",\n\"seconds\":"<<d.seconds
     <<",\n\"temporal_filter\":"<<(cached&&a.temporal&&a.mode!="still"?"true":"false")
     <<",\n\"history_acceptance\":"<<d.historyAcceptance<<",\n\"geometry_animated\":false"
     <<",\n\"camera_animated\":"<<((a.mode=="film"||a.mode=="uncached-film")?"true":"false")
     <<",\n\"full_convergence_certified\":false,\n\"note\":\"Camera statistics exclude cache bias and volume discretization error. Correlated subpixel sampling statistics are descriptive, not rigorous confidence bounds. Every frame has new geometry rays; history reprojection is used only for antialiasing.\"\n}\n";
}
struct Guide {V3 normal{};float depth=1e5f;uint32_t material=~0u;};
std::vector<Guide> makeGuides(const Integrator&in,const FastCamera&cam,int w,int h,int threads,const BVH* tree){
    std::vector<Guide> guides(size_t(w)*h);
    parallel(h,threads,[&](int y){for(int x=0;x<w;x++){
        Ray ray=cam.ray(x+.5f,y+.5f);Hit hit;
        if(in.scene.intersect(ray,hit,tree)){Surface s=in.scene.surface(ray,hit);guides[size_t(y)*w+x]={s.n,hit.t,s.material};}
    }});return guides;
}
float temporalResolve(std::vector<V3>&current,const std::vector<Guide>&guides,const FastCamera&cam,
                      const std::vector<V3>&previous,const std::vector<Guide>&oldGuides,const Camera&oldCamera,int threads){
    if(previous.empty())return 0;
    int w=cam.w,h=cam.h;FastCamera old(oldCamera,w,h);std::vector<V3> output=current;std::atomic<uint64_t> accepted{0};
    parallel(h,threads,[&](int y){uint64_t ok=0;for(int x=0;x<w;x++){
        size_t i=size_t(y)*w+x;const Guide&g=guides[i];if(g.depth>=99999)continue;
        V3 p=cam.eye+cam.ray(x+.5f,y+.5f).d*g.depth,relative=p-old.eye;
        float z=dot(relative,old.fw);if(z<=0)continue;
        float px=(dot(relative,old.right)/(z*old.tx)+1)*w*.5f-.5f,py=(1-dot(relative,old.up)/(z*old.ty))*h*.5f-.5f;
        if(px<0||py<0||px>=w-1||py>=h-1)continue;
        int ix=int(px),iy=int(py);float u=px-ix,v=py-iy,predicted=length(relative);V3 color{};float weight=0;
        for(int dy=0;dy<2;dy++)for(int dx=0;dx<2;dx++){
            size_t j=size_t(iy+dy)*w+ix+dx;const Guide&b=oldGuides[j];
            if(b.material!=g.material||dot(b.normal,g.normal)<.97f||std::abs(b.depth-predicted)>.018f+.0012f*predicted)continue;
            float k=(dx?u:1-u)*(dy?v:1-v);color+=previous[j]*k;weight+=k;
        }
        if(weight<.25f)continue;
        color*=1/weight;V3 lo=current[i],hi=current[i];
        for(int dy=-1;dy<=1;dy++)for(int dx=-1;dx<=1;dx++){
            V3 c=current[size_t(std::clamp(y+dy,0,h-1))*w+std::clamp(x+dx,0,w-1)];
            for(int j=0;j<3;j++){lo[j]=std::min(lo[j],c[j]);hi[j]=std::max(hi[j],c[j]);}
        }
        for(int j=0;j<3;j++)color[j]=clamp(color[j],lo[j]-.003f,hi[j]+.003f);
        output[i]=mix(current[i],color,.68f*std::min(1.f,weight));ok++;
    }accepted+=ok;});
    current.swap(output);return float(accepted)/float(size_t(w)*h);
}
void renderCached(const Args&a,const Integrator&in,const IrradianceCache&cache,const VolumeGrid&grid){
    for(int shot=a.first;shot<=a.last;shot++){
        auto directory=a.out/shots()[shot].name;std::filesystem::create_directories(directory);
        std::vector<V3> previous;std::vector<Guide> oldGuides;Camera oldCamera;
        int begin=a.mode=="still"?0:a.startFrame,end=a.mode=="still"?1:a.endFrame;
        for(int frame=begin;frame<end;frame++){
            auto name=directory/indexName(frame);auto imageName=name.string()+".ppm",reportName=name.string()+".json";
            if(a.resume&&std::filesystem::exists(imageName)&&std::filesystem::exists(reportName)){
                std::cout<<"SKIP "<<shot<<":"<<frame<<'\n';continue;
            }
            auto start=std::chrono::steady_clock::now();
            float t=a.mode=="still"?.5f:(a.frames>1?float(frame)/(a.frames-1):.5f);
            Camera camera=cameraAt(shot,t);FastCamera cam(camera,a.w,a.h);
            BVH cameraTree;if(a.frustum)cameraTree=buildCameraTree(in.scene,cam);
            const BVH* tree=a.frustum?&cameraTree:nullptr;
            FrustumFog fog(camera,a.w,a.h,grid,in.lights,a.threads);
            CachedCameraIntegrator renderer(in,cache,fog,a.w,a.h,a.coherence,tree);
            std::vector<V3> image(size_t(a.w)*a.h);std::vector<float> error(image.size());
            std::atomic<uint64_t> samples{0},lookups{0},misses{0},nonfinite{0};
            parallel(a.h,a.threads,[&](int y){uint64_t localLookups=0,localMisses=0,localBad=0;
                for(int x=0;x<a.w;x++){
                    size_t i=size_t(y)*a.w+x;RunningRadiance radiance;Hit primaryHint,shadowHint;
                    RNG offset(seedAt(i,0,shot+981771));
                    float rx=fract(offset.uniform()+frame*.6180339887f),ry=fract(offset.uniform()+frame*.4142135624f);
                    uint64_t seed=hash64(i^uint64_t(shot+97111));
                    for(int s=0;s<a.spp;s++){
                        float u=fract(rx+(s+.5f)*.7548776662f),v=fract(ry+(s+.5f)*.5698402910f);
                        float px=x+u,py=y+v;
                        V3 value=renderer.shade(cam.ray(px,py),px,py,seed,s+frame*a.spp,localLookups,localMisses,primaryHint,shadowHint);
                        if(!finite(value)){localBad++;value={};}radiance.add(value);
                    }
                    image[i]=radiance.mean;error[i]=radiance.standardError()/std::max(.03f,luminance(radiance.mean));
                }
                lookups+=localLookups;misses+=localMisses;nonfinite+=localBad;samples+=uint64_t(a.w)*a.spp;
            });
            FrameDiagnostics d;d.cameraInstances=uint32_t(a.frustum?cameraTree.indices.size():in.scene.instances.size());d.cameraSamples=samples;d.cacheLookups=lookups;d.cacheMisses=misses;d.nonfinite=nonfinite;
            d.medianCameraSE=quantile(error,.5f);d.p95CameraSE=quantile(error,.95f);
            if(d.nonfinite)throw std::runtime_error("Nonfinite sample in final camera render");
            if(a.temporal&&a.mode!="still"){
                if(a.pfm)writePFM(name.string()+".raw.pfm",image,a.w,a.h);
                auto guides=makeGuides(in,cam,a.w,a.h,a.threads,tree);
                d.historyAcceptance=temporalResolve(image,guides,cam,previous,oldGuides,oldCamera,a.threads);
                previous=image;oldGuides=std::move(guides);oldCamera=camera;
            }
            d.seconds=seconds(start);writePPM(imageName,image,a.w,a.h,a.exposure);
            if(a.pfm||a.mode=="still")writePFM(name.string()+".pfm",image,a.w,a.h);
            writeFrameReport(reportName,a,shot,frame,camera,d,true);
            std::cout<<"FRAME "<<shot<<":"<<frame<<" seconds="<<d.seconds<<" cache_misses="<<d.cacheMisses<<"/"<<d.cacheLookups<<" camera_se="<<d.medianCameraSE<<'\n'<<std::flush;
        }
    }
}
void renderReference(const Args&a,const Integrator&in){
    bool sequence=a.mode=="uncached-film";
    for(int shot=a.first;shot<=a.last;shot++){
        auto directory=sequence?a.out/shots()[shot].name:a.out;std::filesystem::create_directories(directory);
        int begin=sequence?a.startFrame:0,end=sequence?a.endFrame:1;
        for(int frame=begin;frame<end;frame++){
            auto start=std::chrono::steady_clock::now();
            float time=sequence?(a.frames>1?float(frame)/(a.frames-1):.5f):.5f;
            Camera camera=cameraAt(shot,time);FastCamera cam(camera,a.w,a.h);
            std::vector<V3> image(size_t(a.w)*a.h);std::vector<float> error(image.size());
            parallel(a.h,a.threads,[&](int y){for(int x=0;x<a.w;x++){
                size_t i=size_t(y)*a.w+x;RunningRadiance radiance;
                for(int s=0;s<a.spp;s++){
                    RNG rng(seedAt(i,s,shot*39991+934711));
                    V3 value=in.trace(cam.ray(x+rng.uniform(),y+rng.uniform()),rng);
                    if(!finite(value))throw std::runtime_error("Nonfinite reference sample");
                    radiance.add(value);
                }
                image[i]=radiance.mean;error[i]=radiance.standardError()/std::max(.03f,luminance(radiance.mean));
            }});
            auto name=sequence?directory/indexName(frame):directory/shots()[shot].name;
            writePPM(name.string()+".ppm",image,a.w,a.h,a.exposure);writePFM(name.string()+".pfm",image,a.w,a.h);
            FrameDiagnostics d;d.cameraSamples=uint64_t(a.w)*a.h*a.spp;d.medianCameraSE=quantile(error,.5f);
            d.p95CameraSE=quantile(error,.95f);d.seconds=seconds(start);
            writeFrameReport(name.string()+".json",a,shot,frame,camera,d,false);
            std::cout<<"REFERENCE "<<shot<<":"<<frame<<" seconds="<<d.seconds<<" se="<<d.medianCameraSE<<'\n'<<std::flush;
        }
    }
}
int main(int argc,char**argv){
    try{
        Args a=parseFilm(argc,argv);std::filesystem::create_directories(a.out);Scene scene;scene.load(a.assets/"forest.cys");
        Integrator in(scene);in.bark.load(a.assets/"bark.tex");in.soil.load(a.assets/"soil.tex");in.maxDepth=16;
        if(a.mode=="gather"){
            IrradianceCache cache;cache.cell=a.cell;cache.gather(in,a.first,a.last,a.cameraSteps,a.threads);cache.save(a.assets/"forest.irr");
        }else if(a.mode=="bake"){
            IrradianceCache cache;cache.load(a.assets/"forest.irr",scene.fingerprint);
            cache.build(in,a.cacheMin,a.cacheMax,a.target,a.threads,a.assets/"forest.irr",!a.uniformCache);
        }else if(a.mode=="volume"){
            VolumeGrid grid;grid.build(in,a.threads);grid.save(a.assets/"forest.vol");
        }else if(a.mode=="film"||a.mode=="still"){
            IrradianceCache cache;cache.load(a.assets/"forest.irr",scene.fingerprint);
            for(const auto&r:cache.records)if(!r.front.n||(r.twoSided&&!r.back.n))throw std::runtime_error("Unbaked irradiance cache; run --mode bake first");
            VolumeGrid grid;grid.load(a.assets/"forest.vol",scene.fingerprint);renderCached(a,in,cache,grid);
        }else if(a.mode=="scout"||a.mode=="reference"||a.mode=="uncached-film"){
            renderReference(a,in);
        }else throw std::runtime_error("Unknown mode: "+a.mode);
    }catch(const std::exception&e){std::cerr<<"ERROR: "<<e.what()<<'\n';return 1;}
    return 0;
}
