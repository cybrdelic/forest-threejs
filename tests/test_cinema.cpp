#include "lightcache.hpp"
#include <iostream>
#include <filesystem>
#include <fstream>
using namespace cybr;
using namespace cybr::cinema;
int main(){try{
    int count=0;
    auto check=[&](bool condition,const char* label){
        if(!condition)throw std::runtime_error(label);
        std::cout<<"PASS "<<label<<'\n';count++;
    };
    check(shots().size()==12,"twelve camera paths defined");
    bool unique=true;
    for(size_t i=0;i<shots().size();i++)for(size_t j=0;j<i;j++)
        unique&=(length(cameraAt(i,.5f).eye-cameraAt(j,.5f).eye)>.01f);
    check(unique,"shot midpoints distinct");
    bool finiteCamera=true,moving=true,rayAgreement=true;
    for(int i=0;i<12;i++){
        Camera a=cameraAt(i,0),b=cameraAt(i,1);
        finiteCamera&=finite(a.eye)&&finite(a.target)&&finite(b.eye)&&finite(b.target);
        moving&=length(a.eye-b.eye)>.1f;
        for(float t:{0.f,.25f,.5f,.75f,1.f}){
            Camera c=cameraAt(i,t);FastCamera fast(c,1280,720);RNG rng(1);
            for(auto p:{V2{.5f,.5f},V2{640.f,360.f},V2{1279.5f,719.5f}})
                rayAgreement&=length(fast.ray(p.x,p.y).d-c.generate(p.x,p.y,1280,720,rng,0,10).d)<2e-6f;
        }
    }
    check(finiteCamera,"all camera endpoints finite");
    check(moving,"all camera paths translate in 3D");
    check(rayAgreement,"fast camera agrees with reference camera");
    bool range=false;try{cameraAt(12,.5f);}catch(...){range=true;}
    check(range,"invalid camera index rejected");
    check(length(cameraAt(0,-1).eye-cameraAt(0,0).eye)<1e-7,"negative camera time clamps to start");
    check(length(cameraAt(0,2).eye-cameraAt(0,1).eye)<1e-7,"camera time beyond end clamps");
    RunningRadiance mean;mean.add(V3(1));mean.add(V3(3));
    check(std::abs(mean.mean.x-2)<1e-6&&std::abs(mean.standardError()-1)<1e-6,"running mean and standard error");
    RunningRadiance zero;zero.add(V3(0));zero.add(V3(0));
    check(zero.standardError()==0,"zero-variance black estimate finite");
    double sum=0;bool sampleRange=true;
    for(int i=0;i<4096;i++){float x=radicalInverse(i);sum+=x;sampleRange&=x>=0&&x<1;}
    check(sampleRange,"radical inverse bounds");
    check(std::abs(sum/4096-.5)<.001,"radical inverse mean");
    IrradianceCache cache;cache.cell=1;cache.fingerprint=1234;
    Surface s{};s.p={.25f,.25f,.25f};s.n=s.ng={0,1,0};s.material=3;cache.add(s);cache.add(s);
    check(cache.records.size()==1,"deterministic probe key deduplication");
    auto&r=cache.records[0];
    r.front.add({.2f,.3f,.4f});r.front.add({.2f,.3f,.4f});
    r.back.add({.04f,.05f,.06f});r.back.add({.04f,.05f,.06f});
    auto front=cache.lookup(s.p,{0,1,0},3),back=cache.lookup(s.p,{0,-1,0},3);
    check(front.weight>0&&length(front.front-V3(.2f,.3f,.4f))<1e-6,"front irradiance lookup");
    check(back.weight>0&&length(back.front-front.back)<1e-6&&length(back.back-front.front)<1e-6,"leaf two-sided irradiance swap");
    check(cache.lookup({100,100,100},{0,1,0},3).weight==0,"uncovered cache query reports miss");
    check(cache.lookup(s.p,{0,1,0},0).weight==0,"material-side groups prevent cross-surface lookup");
    cache.buildDenseIndex();auto dense=cache.lookup(s.p,{0,1,0},3);
    check(dense.front.x==front.front.x&&dense.front.y==front.front.y&&dense.front.z==front.front.z&&dense.weight==front.weight,"dense key index preserves interpolation exactly");
    check(cache.lookup({9999,9999,9999},{0,1,0},3).weight==0,"dense key bounds preserve miss semantics");
    auto dir=std::filesystem::temp_directory_path()/"cybr_cinema_test";
    std::filesystem::create_directories(dir);auto path=dir/"probe.irr";
    cache.save(path);IrradianceCache loaded;loaded.load(path,1234);
    check(loaded.records.size()==1&&loaded.records[0].front.n==2&&length(loaded.records[0].front.mean-r.front.mean)<1e-6,"irradiance checkpoint round trip");
    bool signature=false;try{loaded.load(path,7654);}catch(...){signature=true;}
    check(signature,"wrong scene fingerprint rejected");
    {std::ofstream f(dir/"truncated.irr",std::ios::binary);f.write("CYIRR03\0",8);}
    bool truncated=false;try{loaded.load(dir/"truncated.irr",1234);}catch(...){truncated=true;}
    check(truncated,"truncated irradiance cache rejected");
    VolumeGrid volume;volume.lo={0,0,0};volume.hi={1,1,1};volume.spacing=1;
    volume.nx=volume.ny=volume.nz=volume.ax=volume.ay=volume.az=2;volume.fingerprint=1234;
    volume.solar.resize(8);volume.ambient.resize(8);
    for(int z=0;z<2;z++)for(int y=0;y<2;y++)for(int x=0;x<2;x++){
        int i=(z*2+y)*2+x;volume.solar[i]=float(x+2*y+3*z);volume.ambient[i]={float(x),float(y),float(z)};
    }
    check(std::abs(volume.sun({.2f,.3f,.4f})-2.f)<1e-5,"trilinear solar field interpolates linear data");
    check(length(volume.indirect({.2f,.3f,.4f})-V3(.2f,.3f,.4f))<1e-5,"trilinear ambient field interpolates linear vector data");
    check(volume.sun({-1,0,0})==0&&length(volume.indirect({2,2,2}))==0,"outside volume contributes no source");
    volume.save(dir/"volume.vol");VolumeGrid v2;v2.load(dir/"volume.vol",1234);
    check(std::abs(v2.sun({.2f,.3f,.4f})-2.f)<1e-5,"volume checkpoint round trip");
    bool volumeSignature=false;try{v2.load(dir/"volume.vol",9812);}catch(...){volumeSignature=true;}
    check(volumeSignature,"wrong volume fingerprint rejected");
    Scene empty;Integrator in(empty);in.lights.extinction=0;in.maxDepth=16;
    RNG a(14),b(14);Ray sunRay({0,0,0},in.lights.sun);V3 full=in.trace(sunRay,a);
    in.includePrimarySun=false;V3 diffuse=in.trace(sunRay,b);
    float omega=2*Pi*(1-std::cos(in.lights.sunRadius));V3 expected=in.lights.irradiance/omega;
    check(length((full-diffuse-expected)/expected)<1e-5,"primary solar emitter excluded exactly in diffuse-cache integrand");
    check(length(diffuse-in.lights.sky(in.lights.sun))<1e-6,"sky remains in diffuse-cache integrand");
    bool caught=false;
    try{parallel(16,4,[&](int i){if(i==7)throw std::runtime_error("test worker");});}catch(...){caught=true;}
    check(caught,"worker exception propagated to caller");
    check(tone(0,2.1f)==0&&tone(100,2.1f)<=1.000001f,"display transform range");
    std::filesystem::remove_all(dir);std::cout<<"CINEMA TESTS "<<count<<" PASSED\n";
}catch(const std::exception&e){std::cerr<<"FAILED "<<e.what()<<'\n';return 1;}return 0;}
