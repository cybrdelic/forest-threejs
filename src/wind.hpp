#pragma once
#include "cinema.hpp"
namespace cybr::cinema {
// Kinematic, rest-pose-referenced bending. Not a mechanical tree solver.
// Both attached leaves and wood follow the same deformation; normals transform
// by its inverse Jacobian. Basal root/trunk material below the anchor is fixed.
class WindState {
    struct Rest { uint32_t mesh; std::vector<Vertex> vertices; float anchor,scale,phase; };
    std::vector<Rest> rest;
public:
    explicit WindState(const Scene& scene){
        for(uint32_t i=0;i<scene.meshes.size();i++){
            const auto&m=scene.meshes[i];const auto&n=m.name;
            bool fern=n.find("fern")!=std::string::npos;
            bool tree=n.find("canopy")==0||n.find("hero_")==0||n.find("native_understory")==0;
            if(!fern&&!tree)continue;
            float h=std::max(.1f,m.bounds.hi.y);
            rest.push_back({i,m.vertices,fern?0.f:1.35f,fern?.075f/(h*h):.00065f,float(i)*1.731f});
        }
    }
    size_t animatedMeshes()const{return rest.size();}
    void apply(Scene& scene,float time,float strength,int threads){
        if(!std::isfinite(time)||!std::isfinite(strength)||strength<0||strength>3)throw std::runtime_error("Invalid wind state");
        parallel(int(rest.size()),threads,[&](int index){
            const auto&r=rest[index];auto&m=scene.meshes[r.mesh];
            float a=strength*r.scale*(std::sin(.91f*time+r.phase)-std::sin(r.phase));
            float b=strength*r.scale*.48f*(std::sin(1.19f*time+r.phase+.6f)-std::sin(r.phase+.6f));
            m.vertices=r.vertices;
            for(size_t i=0;i<m.vertices.size();i++){
                const auto&v=r.vertices[i];auto&out=m.vertices[i];float h=std::max(0.f,v.p.y-r.anchor);
                out.p=v.p+V3(a*h*h,0,b*h*h);
                out.n=normalize(V3(v.n.x,v.n.y-2*h*(a*v.n.x+b*v.n.z),v.n.z));
            }
            m.build();
        });
        std::vector<Box> boxes;boxes.reserve(scene.instances.size());
        for(auto&inst:scene.instances){
            inst.bounds=Box{};const Box&b=scene.meshes[inst.mesh].bounds;
            for(int k=0;k<8;k++)inst.bounds.add(inst.transform.point({(k&1)?b.hi.x:b.lo.x,(k&2)?b.hi.y:b.lo.y,(k&4)?b.hi.z:b.lo.z}));
            boxes.push_back(inst.bounds);
        }
        scene.tlas.build(boxes,2);
    }
};
} // namespace cybr::cinema
