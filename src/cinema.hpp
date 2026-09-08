#pragma once
#include "integrator.hpp"
#include <atomic>
#include <chrono>
#include <thread>
#include <iostream>
#include <functional>
#include <iomanip>
#include <unordered_map>
#include <mutex>
#include <cstring>

namespace cybr::cinema {
struct Shot {
    const char* name;
    V3 eye0, eye1, target0, target1;
    float fov = 49;
};
inline const std::vector<Shot>& shots() {
    // These are world-space camera moves, not transforms on a rendered image.
    static const std::vector<Shot> s = {
        {"01_Threshold", {.35f,1.70f,-12.0f},{-.35f,1.77f,-9.2f}, {.5f,2.3f,15},{.5f,2.4f,15},49},
        {"02_Fern_level", {-.35f,1.36f,-7.6f},{.15f,1.45f,-6.1f}, {-2.6f,.88f,-2.8f},{-2.3f,.97f,-1.8f},45},
        {"03_Trunk_parallax", {1.4f,1.90f,-6.8f},{-.6f,2.00f,-5.8f}, {5.7f,4.8f,8.2f},{5.4f,5.2f,10.6f},52},
        {"04_Into_the_light", {-.65f,1.65f,1.0f},{.3f,1.75f,4.2f}, {1.8f,2.7f,23},{2.8f,3.1f,24},49},
        {"05_Fern_close_pass", {-.25f,1.2f,-7.0f},{.25f,1.35f,-5.7f}, {-2.5f,.88f,-2.5f},{-2.5f,1.00f,-1.4f},39},
        {"06_Under_the_crown", {-.6f,2.1f,-5.5f},{.6f,3.0f,-3.7f}, {-1.5f,15.0f,3.5f},{.6f,19.5f,5.0f},59},
        {"07_Cross_the_glade", {.35f,1.95f,9.0f},{-.20f,2.05f,11.0f}, {-9.0f,3.3f,27.0f},{-7.6f,3.6f,28.0f},53},
        {"08_Fallen_timber", {-.65f,2.15f,-2.1f},{-.20f,2.3f,-.65f}, {-4.6f,.75f,3.6f},{-4.7f,.76f,3.6f},42},
        {"09_Midstory_crane", {.1f,5.6f,-2.8f},{1.3f,8.1f,-.8f}, {1.1f,7.8f,20},{1.8f,10.0f,23},53},
        {"10_Canopy_drift", {-2.4f,27.0f,-5.0f},{.8f,28.0f,-2.0f}, {-.8f,19.5f,4.0f},{1.8f,20.5f,8.0f},57},
        {"11_Overhead", {-2.5f,32.5f,-4.0f},{1.5f,33.0f,-.5f}, {-.2f,2.5f,4.0f},{1.7f,3.2f,7.0f},52},
        {"12_Last_light", {.2f,2.0f,-9.0f},{.0f,3.1f,-12.0f}, {.4f,3.1f,16.0f},{.7f,6.7f,18.0f},50}
    };
    return s;
}
inline Camera cameraAt(int shot, float t) {
    if (shot < 0 || shot >= int(shots().size())) throw std::runtime_error("Invalid shot index");
    const Shot& s = shots()[shot];
    t = clamp(t); float k = t*t*(3-2*t);
    Camera c; c.name=s.name; c.eye=mix(s.eye0,s.eye1,k); c.target=mix(s.target0,s.target1,k);
    c.up={0,1,0}; c.fov=s.fov; return c;
}
struct FastCamera {
    V3 eye, fw, right, up; float tx,ty; int w,h;
    FastCamera(const Camera& c,int width,int height):eye(c.eye),w(width),h(height) {
        fw=normalize(c.target-c.eye); right=normalize(cross(fw,c.up)); up=cross(right,fw);
        ty=std::tan(c.fov*Pi/360.f); tx=ty*width/height;
    }
    Ray ray(float x,float y) const {
        Ray ray(eye,normalize(fw+right*((2*x/w-1)*tx)+up*((1-2*y/h)*ty)));
        ray.coneSpread = 2*ty/float(h);
        return ray;
    }
};
// Conservative pinhole frustum culling for primary camera rays only.
// Shadow and secondary lighting rays always use the complete scene hierarchy.
inline BVH buildCameraTree(const Scene& scene,const FastCamera& camera){
    const V3 planes[]={camera.fw,camera.fw*camera.tx+camera.right,camera.fw*camera.tx-camera.right,
                       camera.fw*camera.ty+camera.up,camera.fw*camera.ty-camera.up};
    std::vector<Box> bounds;std::vector<uint32_t> ids;
    for(uint32_t i=0;i<scene.instances.size();i++){
        const Box& box=scene.instances[i].bounds;bool visible=true;
        for(V3 n:planes){
            V3 positive{n.x>=0?box.hi.x:box.lo.x,n.y>=0?box.hi.y:box.lo.y,n.z>=0?box.hi.z:box.lo.z};
            if(dot(positive-camera.eye,n)<-.05f){visible=false;break;}
        }
        if(visible){bounds.push_back(box);ids.push_back(i);}
    }
    BVH tree;if(!bounds.empty()){
        tree.build(bounds,2);
        for(auto& index:tree.indices)index=ids[index];
    }
    return tree;
}
template<class F> void parallel(int count,int threads,F fn) {
    std::atomic<int> next{0}; std::exception_ptr err; std::mutex mutex;
    std::vector<std::thread> jobs;
    threads=std::min(std::max(1,threads),std::max(1,count));
    for(int t=0;t<threads;t++) jobs.emplace_back([&]{
        try {int k; while((k=next.fetch_add(1))<count) fn(k);}
        catch(...) {std::lock_guard lock(mutex);err=std::current_exception();next=count;}
    });
    for(auto& job:jobs) job.join();
    if(err) std::rethrow_exception(err);
}
inline float tone(float v,float exposure) {
    v=std::max(0.f,v*exposure);
    v=clamp(v*(2.51f*v+.03f)/(v*(2.43f*v+.59f)+.14f));
    return v<=.0031308f?12.92f*v:1.055f*std::pow(v,1/2.4f)-.055f;
}
inline void writePPM(const std::filesystem::path& path,const std::vector<V3>& pixels,int w,int h,float exposure=2.1f) {
    if(pixels.size()!=size_t(w)*h) throw std::runtime_error("Image dimensions disagree");
    std::ofstream f(path,std::ios::binary);
    if(!f) throw std::runtime_error("Cannot write "+path.string());
    f<<"P6\n"<<w<<" "<<h<<"\n255\n";
    for(V3 p:pixels){unsigned char c[3];for(int j=0;j<3;j++)c[j]=uint8_t(clamp(tone(p[j],exposure))*255+.5f);f.write((char*)c,3);}
    if(!f) throw std::runtime_error("Image write failed");
}
inline void writePFM(const std::filesystem::path& path,const std::vector<V3>& pixels,int w,int h) {
    static_assert(sizeof(V3)==12);
    std::ofstream f(path,std::ios::binary);if(!f)throw std::runtime_error("Cannot write "+path.string());
    f<<"PF\n"<<w<<" "<<h<<"\n-1.0\n";
    for(int y=h-1;y>=0;y--) f.write((const char*)&pixels[size_t(y)*w],w*sizeof(V3));
    if(!f)throw std::runtime_error("PFM write failed");
}
inline std::string indexName(int i,int pad=5){std::ostringstream s;s<<std::setw(pad)<<std::setfill('0')<<i;return s.str();}
inline float seconds(std::chrono::steady_clock::time_point start){return std::chrono::duration<float>(std::chrono::steady_clock::now()-start).count();}
inline uint64_t seedAt(uint64_t i,uint64_t n,uint64_t seed=934771){return hash64(i^seed)^hash64(n*0x9e3779b97f4a7c15ULL);}
inline float radicalInverse(uint32_t bits) {
    bits=(bits<<16)|(bits>>16);bits=((bits&0x55555555u)<<1)|((bits&0xaaaaaaaau)>>1);
    bits=((bits&0x33333333u)<<2)|((bits&0xccccccccu)>>2);bits=((bits&0x0f0f0f0fu)<<4)|((bits&0xf0f0f0f0u)>>4);
    bits=((bits&0x00ff00ffu)<<8)|((bits&0xff00ff00u)>>8);
    return std::min(float(double(bits)*2.3283064365386963e-10),.99999994f);
}
inline V3 safeOffset(const Surface& s,V3 d){return s.p+s.ng*(dot(s.ng,d)>=0?.0004f:-.0004f);}
} // namespace cybr::cinema
