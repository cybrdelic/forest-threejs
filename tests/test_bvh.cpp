// Independent, world-space reference tests for the accelerated instanced BVH.
// The reference does not invoke packetHit, triHit, or either BVH traversal.
#include "scene.hpp"
#include "cinema.hpp"
#include <cmath>
#include <iostream>
#include <random>
#include <vector>

using namespace cybr;

struct D3 {
    double x, y, z;
    explicit D3(V3 v) : x(v.x), y(v.y), z(v.z) {}
    D3(double a, double b, double c) : x(a), y(b), z(c) {}
    D3 operator-(D3 b) const { return {x-b.x,y-b.y,z-b.z}; }
};
D3 crossD(D3 a, D3 b) { return {a.y*b.z-a.z*b.y,a.z*b.x-a.x*b.z,a.x*b.y-a.y*b.x}; }
double dotD(D3 a, D3 b) { return a.x*b.x+a.y*b.y+a.z*b.z; }
struct RefTriangle { D3 a, b, c; uint32_t instance, face; };

bool referenceHit(const std::vector<RefTriangle>& triangles, const Ray& ray,
                  double& closest, uint32_t& instance, uint32_t& face) {
    bool found=false;
    for (const auto& t : triangles) {
        D3 e1=t.b-t.a, e2=t.c-t.a, p=crossD(D3(ray.d),e2);
        double det=dotD(e1,p);
        if (std::abs(det)<1e-15) continue;
        D3 s=D3(ray.o)-t.a;
        double u=dotD(s,p)/det;
        if(u<0||u>1) continue;
        D3 q=crossD(s,e1);
        double v=dotD(D3(ray.d),q)/det;
        if(v<0||u+v>1) continue;
        double distance=dotD(e2,q)/det;
        if(distance>=ray.tmin&&distance<closest&&distance<ray.tmax) {
            closest=distance; instance=t.instance; face=t.face; found=true;
        }
    }
    return found;
}

int main() {
    try {
        std::mt19937 rng(31767);
        std::uniform_real_distribution<float> uniform(-1.f,1.f);
        auto randomV=[&]() { return V3(uniform(rng),uniform(rng),uniform(rng)); };
        Scene scene;
        for (int m=0;m<4;++m) {
            Mesh mesh; mesh.name="reference_mesh_"+std::to_string(m);
            for(uint32_t f=0;f<128;++f) {
                V3 center=randomV()*2;
                V3 e1=randomV()*.8f, e2=randomV()*.8f;
                V3 normal=normalize(cross(e1,e2));
                uint32_t first=uint32_t(mesh.vertices.size());
                mesh.vertices.push_back({center,normal,{0,0},V3(.3f)});
                mesh.vertices.push_back({center+e1,normal,{1,0},V3(.3f)});
                mesh.vertices.push_back({center+e2,normal,{0,1},V3(.3f)});
                mesh.faces.push_back({first,first+1,first+2,1});
            }
            mesh.build(); scene.meshes.push_back(std::move(mesh));
        }
        std::vector<Box> bounds;
        std::vector<RefTriangle> reference;
        float inverseError=0;
        for (uint32_t i=0;i<31;++i) {
            float a=uniform(rng)*3.14159265f, c=std::cos(a), s=std::sin(a);
            V3 scale(.5f+.8f*(uniform(rng)+1),.5f+.8f*(uniform(rng)+1),.5f+.8f*(uniform(rng)+1));
            // Include negative determinant / mirrored instances.
            if(i%5==0) scale.x=-scale.x;
            V3 translation=randomV()*7;
            Instance inst; inst.mesh=i%4;
            inst.transform.m={c*scale.x,0,s*scale.z,translation.x,
                              0,scale.y,0,translation.y,
                              -s*scale.x,0,c*scale.z,translation.z};
            inst.inverse.m={c/scale.x,0,-s/scale.x,0,
                            0,1/scale.y,0,0,
                            s/scale.z,0,c/scale.z,0};
            V3 it=-inst.inverse.vector(translation);
            inst.inverse.m[3]=it.x;inst.inverse.m[7]=it.y;inst.inverse.m[11]=it.z;
            for(int k=0;k<12;++k) {
                V3 p=randomV()*3;
                inverseError=std::max(inverseError,length(inst.inverse.point(inst.transform.point(p))-p));
            }
            const Mesh& mesh=scene.meshes[inst.mesh];
            for(const auto& v:mesh.vertices) inst.bounds.add(inst.transform.point(v.p));
            inst.bounds.lo=inst.bounds.lo-V3(1e-5f);
            inst.bounds.hi=inst.bounds.hi+V3(1e-5f);
            for(uint32_t j=0;j<mesh.faces.size();++j) {
                const Face& f=mesh.faces[j];
                reference.push_back({D3(inst.transform.point(mesh.vertices[f.a].p)),
                                     D3(inst.transform.point(mesh.vertices[f.b].p)),
                                     D3(inst.transform.point(mesh.vertices[f.c].p)),i,j});
            }
            bounds.push_back(inst.bounds);scene.instances.push_back(inst);
        }
        scene.tlas.build(bounds,2);
        int hits=0, mismatch=0, normalFailures=0, shadowFailures=0, hintFailures=0, hintShadowFailures=0;
        Hit previousHint, shadowHint;
        double worstRelative=0;
        for(int k=0;k<2500;++k) {
            V3 origin=randomV()*14;
            V3 direction=normalize(randomV()*7-origin);
            if(k%100==0) direction=V3(0,0,k%200?1.f:-1.f);
            float far=k%3==0?4.f:100.f;
            Ray ray(origin,direction,1e-4f,far);
            Hit h;bool accelerated=scene.intersect(ray,h);
            double t=far;uint32_t instance=~0u, face=~0u;
            bool brute=referenceHit(reference,ray,t,instance,face);
            if(brute) ++hits;
            if(accelerated!=brute) ++mismatch;
            if(accelerated&&brute) {
                double rel=std::abs(double(h.t)-t)/std::max(1.,t);
                worstRelative=std::max(worstRelative,rel);
                if(rel>3e-4||h.instance!=instance||h.face!=face) ++mismatch;
                Surface surf=scene.surface(ray,h);
                if(!finite(surf.n)||std::abs(length(surf.n)-1)>2e-5||dot(surf.ng,-ray.d)<0) ++normalFailures;
            }
            if(scene.occluded(ray)!=brute) ++shadowFailures;
            // Correct, stale, invalid and arbitrary hints are tested against
            // the same independently transformed double-precision reference.
            Hit arbitrary;arbitrary.instance=uint32_t(k%31);arbitrary.face=uint32_t((k*37)%128);
            for(const Hit& hint:{h,previousHint,arbitrary,Hit{}}){
                Hit candidate;bool found=scene.intersectHint(ray,candidate,hint);
                if(found!=brute)hintFailures++;
                if(found&&brute&&(std::abs(double(candidate.t)-t)/std::max(1.,t)>3e-4||candidate.instance!=instance||candidate.face!=face))hintFailures++;
            }
            if(scene.occludedHint(ray,shadowHint)!=brute)hintShadowFailures++;
            Hit exactShadow=h;if(scene.occludedHint(ray,exactShadow)!=brute)hintShadowFailures++;
            previousHint=h;
        }
        int frustumFailures=0;size_t frustumQueries=0;
        for(int view=0;view<16;view++){
            Camera camera;camera.eye=randomV()*18;camera.target={0,0,0};camera.fov=35+view*3;
            cinema::FastCamera fc(camera,640,360);BVH visibility=cinema::buildCameraTree(scene,fc);
            for(int i=0;i<512;i++){
                Ray ray=fc.ray((uniform(rng)+1)*320,(uniform(rng)+1)*180);Hit a,b;
                bool full=scene.intersect(ray,a),culled=scene.intersect(ray,b,&visibility);frustumQueries++;
                if(full!=culled||(full&&(std::abs(a.t-b.t)>1e-4f||a.instance!=b.instance||a.face!=b.face)))frustumFailures++;
            }
        }
        std::cout<<"FRUSTUM queries="<<frustumQueries<<" failures="<<frustumFailures<<'\n';
        if(frustumFailures)return 1;
        std::cout<<"REFERENCE rays=2500 triangles="<<reference.size()<<" hits="<<hits
                 <<" nearest_mismatches="<<mismatch<<" shadow_mismatches="<<shadowFailures
                 <<" normal_failures="<<normalFailures<<" max_relative_hit_error="<<worstRelative
                 <<" max_inverse_error="<<inverseError<<" hinted_nearest_mismatches="<<hintFailures<<" hinted_shadow_mismatches="<<hintShadowFailures<<'\n';
        if(mismatch||shadowFailures||normalFailures||hintFailures||hintShadowFailures||inverseError>1e-4) return 1;
        std::cout<<"PASS independently transformed double-precision nearest-hit reference\n"
                 <<"PASS finite-interval any-hit reference\n"
                 <<"PASS 8192 conservative camera-frustum closest-hit queries\n"
                 <<"PASS 10000 exact hinted closest-hit queries\n"
                 <<"PASS 5000 exact hinted occlusion queries\n"
                 <<"PASS nonuniform and mirrored affine inverse\n"
                 <<"PASS transformed normal orientation and normalization\n";
        return 0;
    } catch(const std::exception& e) { std::cerr<<e.what()<<'\n';return 1; }
}
