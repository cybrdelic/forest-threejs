#include "lightcache.hpp"
#include "wind.hpp"
#include <filesystem>
#include <iostream>
#include <limits>
#include <vector>
using namespace cybr;
using namespace cybr::cinema;
int main(){try{
    int count=0;auto check=[&](bool condition,const char* message){
        if(!condition)throw std::runtime_error(message);
        std::cout<<"PASS "<<message<<'\n';++count;
    };
    auto constant=[](V3 color){Texture t;t.width=t.height=1;t.pixels.resize(1);t.pixels[0].color=color;t.buildMipmaps();return t;};
    Texture checker;checker.width=checker.height=8;checker.pixels.resize(64);
    for(int y=0;y<8;y++)for(int x=0;x<8;x++){
        auto& t=checker.pixels[size_t(y)*8+x];t.color=V3(float((x+y)&1));t.du=((x+y)&1)?1.f:-1.f;
        t.dv=-t.du;t.rough=.73f;t.height=t.color.x;
    }
    checker.buildMipmaps();check(checker.mipmaps.size()==3,"full mip hierarchy reaches one texel");
    auto sample=checker.sample(.123f,.781f,1);
    check(length(sample.color-V3(.5f))<1e-6f,"minified checkerboard integrates to its mean");
    check(std::abs(sample.du)<1e-6f&&std::abs(sample.dv)<1e-6f,"opposing high-frequency slopes cancel");
    check(std::abs(sample.rough-.73f)<1e-6f,"constant roughness survives minification");
    check(length(checker.sample(-.32f,-1.72f,.1f).color-checker.sample(.68f,.28f,.1f).color)<2e-6,"negative periodic UV wrapping");
    check(length(checker.sample(.5f/8,.5f/8).color)<1e-6,"bilinear samples align with texel centres");
    check(length(checker.sample(1.5f/8,.5f/8).color-V3(1))<1e-6,"unminified high frequency remains intact");
    bool rejected=false;try{checker.sample(std::numeric_limits<float>::quiet_NaN(),0);}catch(...){rejected=true;}
    check(rejected,"nonfinite texture coordinate rejected");
    Texture bad=checker;bad.pixels[9].color.x=std::numeric_limits<float>::infinity();rejected=false;
    try{bad.buildMipmaps();}catch(...){rejected=true;}check(rejected,"nonfinite texture content rejected");
    Texture odd;odd.width=7;odd.height=3;odd.pixels.resize(21);for(auto&x:odd.pixels)x.color={.1f,.2f,.3f};odd.buildMipmaps();
    check(length(odd.sample(.19f,.76f,1).color-V3(.1f,.2f,.3f))<1e-6,"odd-sized mipmaps preserve constants");
    Scene scene;scene.fingerprint=123;Integrator in(scene);in.bark=constant({.2f,.14f,.08f});in.soil=constant({.1f,.08f,.04f});
    uint64_t initial=in.transportFingerprint();
    in.bark.pixels[0].color.x+=.001f;in.bark.buildMipmaps();check(in.transportFingerprint()!=initial,"bark content invalidates transport");
    in.bark.pixels[0].color.x-=.001f;in.bark.buildMipmaps();initial=in.transportFingerprint();
    in.soil.pixels[0].rough=.22f;in.soil.buildMipmaps();check(in.transportFingerprint()!=initial,"soil roughness invalidates transport");
    initial=in.transportFingerprint();in.lights.irradiance.x+=1;check(in.transportFingerprint()!=initial,"sun energy invalidates transport");
    initial=in.transportFingerprint();in.lights.skyScale.z+=1;check(in.transportFingerprint()!=initial,"skylight invalidates transport");
    initial=in.transportFingerprint();in.lights.anisotropy+=.01f;check(in.transportFingerprint()!=initial,"phase function invalidates transport");
    initial=in.transportFingerprint();in.lights.volume.hi.y+=1;check(in.transportFingerprint()!=initial,"medium bounds invalidate transport");
    initial=in.transportFingerprint();in.lights.sunRadius*=1.1f;check(in.transportFingerprint()!=initial,"solar solid angle invalidates transport");
    initial=in.transportFingerprint();in.maxDepth+=1;check(in.transportFingerprint()!=initial,"path depth invalidates transport");
    initial=in.transportFingerprint();in.includePrimarySun=!in.includePrimarySun;check(in.transportFingerprint()!=initial,"primary-emitter mode invalidates transport");
    initial=in.transportFingerprint();scene.fingerprint++;check(in.transportFingerprint()!=initial,"geometry invalidates transport");
    IrradianceCache cache;cache.fingerprint=in.transportFingerprint();Surface surface{};surface.p={0,0,0};surface.n=surface.ng={0,1,0};surface.material=3;cache.add(surface);
    cache.records[0].front.add({.1f,.2f,.3f});cache.records[0].back.add({.1f,.2f,.3f});
    auto dir=std::filesystem::temp_directory_path()/"cybr_quality_tests";std::filesystem::create_directories(dir);cache.save(dir/"probe.irr");
    IrradianceCache loaded;loaded.load(dir/"probe.irr",in.transportFingerprint());
    check(loaded.records.size()==1,"unchanged transport accepts cache");
    in.lights.irradiance.y+=.001f;rejected=false;try{loaded.load(dir/"probe.irr",in.transportFingerprint());}catch(...){rejected=true;}
    check(rejected,"real cache file rejects changed sunlight");
    // A deliberately deformed triangle with stale old normals.
    Mesh mesh;mesh.vertices={{{0,0,0},{0,1,0},{0,0},{.1f,.1f,.1f}},{{2,1,0},{0,1,0},{1,0},{.1f,.1f,.1f}},{{0,0,2},{0,1,0},{0,1},{.1f,.1f,.1f}}};mesh.faces={{0,2,1,0}};
    mesh.recomputeNormals();V3 ng=normalize(cross(mesh.vertices[2].p,mesh.vertices[1].p));
    check(length(mesh.vertices[0].n-ng)<1e-6,"deformation rebuilds actual area-weighted normals");
    check(std::abs(mesh.vertices[0].n.x)>.1f,"normal rebuild does more than normalize stale normals");
    scene.meshes={mesh};Instance instance;instance.mesh=0;instance.transform.m=instance.inverse.m={1,0,0,0,0,1,0,0,0,0,1,0};scene.instances={instance};
    Hit hit;hit.instance=hit.face=0;hit.u=.2f;hit.v=.3f;hit.t=2;Ray ray({.6f,3,.4f},{0,-1,0});ray.coneSpread=.005f;
    for(int mirrored=0;mirrored<2;mirrored++){
        for(auto&v:scene.meshes[0].vertices)v.uv.x*=mirrored?-1.f:1.f;
        Surface s=scene.surface(ray,hit);
        check(std::abs(dot(s.n,s.tangent))<1e-6&&std::abs(dot(s.n,s.bitangent))<1e-6,"tangents orthogonal to shading normal");
        check(std::abs(dot(s.tangent,s.bitangent))<1e-6,"tangent frame orthogonal after nonflat deformation");
        check(std::abs(length(s.tangent)-1)<1e-6&&std::abs(length(s.bitangent)-1)<1e-6,"tangent frame normalized");
        V3 dpdu=scene.meshes[0].vertices[1].p*(mirrored?-1.f:1.f);
        check(dot(dpdu,s.tangent)>.1f,"mirrored UV handedness preserved");
        check(s.footprint>0&&s.uvFootprint.x>0&&s.uvFootprint.y>0,"ray-cone footprint reaches material sampling");
    }
    Camera camera=cameraAt(0,.5f);FastCamera fast(camera,1280,720);RNG rng(7);
    check(std::abs(fast.ray(400,200).coneSpread-camera.generate(400,200,1280,720,rng,0,10).coneSpread)<1e-8,"film and reference use matching pixel footprints");
    Mesh plane;plane.vertices={{{-20,0,-20},{0,1,0},{0,0},{.1f,.1f,.1f}},{{20,0,-20},{0,1,0},{1,0},{.1f,.1f,.1f}},{{20,0,20},{0,1,0},{1,1},{.1f,.1f,.1f}},{{-20,0,20},{0,1,0},{0,1},{.1f,.1f,.1f}}};plane.faces={{0,2,1,0},{0,3,2,0}};plane.build();
    Scene test;test.meshes.push_back(plane);instance.bounds=plane.bounds;test.instances.push_back(instance);test.tlas.build({plane.bounds});
    Integrator both(test);both.bark=constant({.2f,.1f,.05f});both.soil=constant({.1f,.15f,.04f});both.maxDepth=8;both.lights.extinction=0;
    Integrator sun=both,sky=both;sun.lights.skyScale=V3(0);sky.lights.irradiance=V3(0);
    double worst=0;V3 mean{};
    for(int i=0;i<1024;i++){
        Ray r({0,1,0},normalize({.1f,-1,.2f}));RNG a(i+23),b(i+23),c(i+23);
        V3 total=both.trace(r,a),parts=sun.trace(r,b)+sky.trace(r,c);mean+=total;
        worst=std::max(worst,double(length(total-parts)/std::max(.02f,length(total))));
    }
    check(maxc(mean)>0,"uncached isolated-lighting fixture receives illumination");
    check(worst<2e-5,"sun-only plus sky-only equals combined uncached surface transport");

    // Repeated deformation must never append stale packets or retain old bounds.
    Mesh animated;animated.name="canopy_fixture";animated.vertices={{{0,0,0},{0,0,1},{0,0},{.1f,.1f,.1f}},{{1,0,0},{0,0,1},{1,0},{.1f,.1f,.1f}},{{0,5,0},{0,0,1},{0,1},{.1f,.1f,.1f}}};animated.faces={{0,1,2,1}};animated.build();
    Scene windy;windy.meshes.push_back(animated);instance.bounds=animated.bounds;windy.instances.push_back(instance);windy.tlas.build({animated.bounds});WindState wind(windy);
    check(wind.animatedMeshes()==1,"wind selects real tree mesh");
    wind.apply(windy,0,1,1);check(length(windy.meshes[0].vertices[2].p-animated.vertices[2].p)==0,"wind zero time restores exact rest positions");
    wind.apply(windy,1,1,1);check(length(windy.meshes[0].vertices[2].p-animated.vertices[2].p)>1e-5,"wind moves attached upper geometry");
    check(length(windy.meshes[0].vertices[0].p-animated.vertices[0].p)==0,"wind keeps basal roots anchored");
    check(std::abs(length(windy.meshes[0].vertices[2].n)-1)<1e-6,"wind normals remain normalized");
    size_t packetCount=windy.meshes[0].packets.size();for(int k=1;k<20;k++)wind.apply(windy,k*.2f,1,1);
    check(windy.meshes[0].packets.size()==packetCount,"repeated BVH rebuilding does not append stale packets");
    Hit exact;auto&p=windy.meshes[0].vertices;V3 centroid=(p[0].p+p[1].p+p[2].p)/3.f;Ray visible(centroid+V3(0,0,2),{0,0,-1});
    check(windy.intersect(visible,exact),"deformed mesh is intersected by the current acceleration structure");
    wind.apply(windy,0,1,1);check(length(windy.meshes[0].bounds.hi-animated.bounds.hi)<1e-6,"restoration shrinks bounds instead of retaining old excursions");
    BVH empty;empty.build({animated.bounds});empty.build({});check(empty.wide.empty()&&empty.nodes.empty()&&empty.indices.empty(),"empty rebuild removes stale wide BVH");
    Camera lensCamera=cameraAt(0,.5f);RNG lr(42);Ray lensRay=lensCamera.generate(640,360,1280,720,lr,.01f,8);
    check(length(lensRay.o-lensCamera.eye)>0,"finite aperture samples a physical lens origin");
    std::filesystem::remove_all(dir);
    std::cout<<"QUALITY TESTS "<<count<<" PASSED; lighting worst normalized residual "<<worst<<'\n';
}catch(const std::exception&e){std::cerr<<"FAILED "<<e.what()<<'\n';return 1;}return 0;}
