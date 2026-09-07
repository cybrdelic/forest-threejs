#include "lightcache.hpp"
#include <algorithm>
namespace cybr::cinema {
namespace {
template<class T> void write(std::ofstream& f,const T& x){f.write((const char*)&x,sizeof(x));}
template<class T> void read(std::ifstream& f,T& x){f.read((char*)&x,sizeof(x));if(!f)throw std::runtime_error("Truncated lighting cache");}
float percentile(std::vector<float> v,float q){if(v.empty())return 0;size_t k=std::min(v.size()-1,size_t(q*(v.size()-1)));std::nth_element(v.begin(),v.begin()+k,v.end());return v[k];}
V3 canonical(V3 n,uint32_t mat){if((mat==2||mat==3||mat==4)&&n.y<0)n=-n;return n;}
}
uint32_t IrradianceCache::group(uint32_t m){if(m==0||m==6)return 0;if(m==1||m==7)return 1;if(m==5)return 3;return 2;}
uint32_t IrradianceCache::axis(V3 n){int a=0;if(std::abs(n.y)>std::abs(n.x))a=1;if(std::abs(n.z)>std::abs(n[a]))a=2;return 2*a+(n[a]<0);}
CacheKey IrradianceCache::key(V3 p,V3 n,uint32_t m)const{return{int32_t(std::floor(p.x/cell)),int32_t(std::floor(p.y/cell)),int32_t(std::floor(p.z/cell)),group(m),axis(n)};}
int64_t IrradianceCache::findRecord(CacheKey k)const{
    if(!denseIndex.empty()){
        int64_t x=int64_t(k.x)-denseX,y=int64_t(k.y)-denseY,z=int64_t(k.z)-denseZ;
        if(x<0||y<0||z<0||x>=denseNX||y>=denseNY||z>=denseNZ||k.group>=4||k.axis>=6)return -1;
        size_t address=((size_t(z)*denseNY+size_t(y))*denseNX+size_t(x))*24+k.group*6+k.axis;
        return denseIndex[address];
    }
    auto it=index.find(k);return it==index.end()?-1:int64_t(it->second);
}
void IrradianceCache::buildDenseIndex(){
    denseIndex.clear();if(records.empty())return;
    int64_t lo[3]={INT32_MAX,INT32_MAX,INT32_MAX},hi[3]={INT32_MIN,INT32_MIN,INT32_MIN};
    for(const auto&r:records){int64_t p[3]={r.key.x,r.key.y,r.key.z};for(int a=0;a<3;a++){lo[a]=std::min(lo[a],p[a]);hi[a]=std::max(hi[a],p[a]);}}
    uint64_t extent[3];for(int a=0;a<3;a++){extent[a]=uint64_t(hi[a]-lo[a]+1);if(extent[a]>100000)return;}
    uint64_t count=extent[0]*extent[1]*extent[2]*24;
    if(count>64ULL*1024*1024)return; // Hash fallback for sparse/outlier bounds.
    denseX=int32_t(lo[0]);denseY=int32_t(lo[1]);denseZ=int32_t(lo[2]);
    denseNX=uint32_t(extent[0]);denseNY=uint32_t(extent[1]);denseNZ=uint32_t(extent[2]);
    denseIndex.assign(size_t(count),-1);
    for(size_t i=0;i<records.size();i++){
        auto k=records[i].key;size_t address=((size_t(int64_t(k.z)-denseZ)*denseNY+size_t(int64_t(k.y)-denseY))*denseNX+size_t(int64_t(k.x)-denseX))*24+k.group*6+k.axis;
        denseIndex[address]=int32_t(i);
    }
}
void IrradianceCache::add(const Surface& s){
    if(!denseIndex.empty())denseIndex.clear();
    V3 n=canonical(s.n,s.material);auto k=key(s.p,n,s.material);
    if(index.find(k)==index.end()){
        IrradianceRecord r{};r.key=k;r.p=s.p;r.n=n;r.twoSided=(group(s.material)==2);
        index.emplace(k,uint32_t(records.size()));records.push_back(r);
    }
}
void IrradianceCache::gather(const Integrator& in,int first,int last,int cameraSteps,int threads){
    fingerprint=in.scene.fingerprint;constexpr int w=160,h=90;
    for(int shot=first;shot<=last;shot++){
        auto start=std::chrono::steady_clock::now();
        for(int t=0;t<cameraSteps;t++){
            FastCamera cam(cameraAt(shot,cameraSteps>1?float(t)/(cameraSteps-1):.5f),w,h);
            std::vector<Surface> hitSurfaces(size_t(w)*h);std::vector<uint8_t> valid(size_t(w)*h);
            parallel(h,threads,[&](int y){for(int x=0;x<w;x++){
                size_t i=size_t(y)*w+x;RNG rng(seedAt(i,t,shot+394711));Ray ray=cam.ray(x+rng.uniform(),y+rng.uniform());Hit hit;
                if(in.scene.intersect(ray,hit)){
                    auto s=in.scene.surface(ray,hit);s.n=in.shade(s,-ray.d).n;
                    hitSurfaces[i]=s;valid[i]=1;
                }
            }});
            // Serial insertion fixes probe identity independently of thread order.
            for(size_t i=0;i<valid.size();i++)if(valid[i])add(hitSurfaces[i]);
        }
        std::cout<<"GATHER shot="<<shot<<" records="<<records.size()<<" seconds="<<seconds(start)<<'\n'<<std::flush;
    }
}
void IrradianceCache::build(const Integrator& original,int minSamples,int maxSamples,float relativeTarget,int threads,const std::filesystem::path& checkpoint,bool footprintAware){
    Integrator in(original.scene);in.bark=original.bark;in.soil=original.soil;in.lights=original.lights;
    in.maxDepth=original.maxDepth;in.includePrimarySun=false;in.lights.extinction=0;
    auto start=std::chrono::steady_clock::now();std::atomic<uint64_t> done{0},rays{0};std::atomic<bool> finish{false};
    std::thread progress([&]{while(!finish){std::this_thread::sleep_for(std::chrono::seconds(5));if(!finish)std::cout<<"BAKE done="<<done<<"/"<<records.size()<<" paths="<<rays<<" seconds="<<seconds(start)<<'\n'<<std::flush;}});
    try{
        parallel(int(records.size()),threads,[&](int i){auto& r=records[i];
            float cameraDistance=Inf;
            for(size_t shot=0;shot<shots().size();shot++)for(float t:{0.f,.5f,1.f})
                cameraDistance=std::min(cameraDistance,length(r.p-cameraAt(int(shot),t).eye));
            uint32_t cap=uint32_t(maxSamples);
            // Explicit footprint-aware caps, never treated as convergence.
            if(footprintAware&&cameraDistance>35)cap=std::min(cap,512u);
            else if(footprintAware&&cameraDistance>20)cap=std::min(cap,1024u);
            else if(footprintAware&&cameraDistance>10)cap=std::min(cap,2048u);
            cap=std::max(cap,uint32_t(minSamples));
            auto integrate=[&](RunningRadiance& accum,V3 normal,uint64_t salt){
                while(accum.n<cap){
                    uint32_t stop=std::min(cap,accum.n+128u);
                    for(uint32_t n=accum.n;n<stop;n++){
                        RNG rng(seedAt(i,n,934771^salt));V3 dir=cosine(rng,normal);
                        V3 value=in.trace(Ray(r.p+normal*.002f,dir),rng);
                        if(!finite(value))throw std::runtime_error("Nonfinite cache radiance");
                        accum.add(value);
                    }
                    if(accum.n>=uint32_t(minSamples)&&1.96f*accum.standardError()<=relativeTarget*std::max(.03f,luminance(accum.mean)))break;
                }
                rays+=accum.n;
            };
            integrate(r.front,r.n,0xadc387);if(r.twoSided)integrate(r.back,-r.n,0x78ab19);done++;
        });
    }catch(...){finish=true;progress.join();throw;}
    finish=true;progress.join();save(checkpoint);report(checkpoint.string()+".json");
    std::cout<<"BAKE FINISHED paths="<<rays<<" seconds="<<seconds(start)<<'\n'<<std::flush;
}
CacheResult IrradianceCache::lookup(V3 p,V3 n,uint32_t material)const{
    bool reverse=(group(material)==2&&n.y<0);if(reverse)n=-n;
    CacheKey base=key(p,n,material);CacheResult result;
    auto addCell=[&](CacheKey k){int64_t id=findRecord(k);if(id<0)return;
        const auto&r=records[size_t(id)];float agreement=dot(n,r.n);if(agreement<.55f)return;
        V3 d=p-r.p;float plane=std::abs(dot(d,r.n)),dist2=length2(d);
        if(material==0&&plane>.26f)return;
        float w=std::pow(agreement,8.f)/(.07f+dist2/(cell*cell));
        result.front+=r.front.mean*w;result.back+=r.back.mean*w;result.weight+=w;
    };
    addCell(base);
    float fx=p.x/cell-std::floor(p.x/cell),fy=p.y/cell-std::floor(p.y/cell),fz=p.z/cell-std::floor(p.z/cell);
    int dx=fx<.5f?-1:1,dy=fy<.5f?-1:1,dz=fz<.5f?-1:1;
    for(int mask=1;mask<8;mask++){
        auto k=base;k.x+=(mask&1)?dx:0;k.y+=(mask&2)?dy:0;k.z+=(mask&4)?dz:0;addCell(k);
    }
    if(result.weight<1e-6f){
        for(int z=-1;z<=1;z++)for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++)for(uint32_t ax=0;ax<6;ax++){
            auto k=base;k.x+=x;k.y+=y;k.z+=z;k.axis=ax;addCell(k);
        }
    }
    if(result.weight>0){result.front*=1/result.weight;result.back*=1/result.weight;}
    if(reverse)std::swap(result.front,result.back);
    return result;
}
void IrradianceCache::save(const std::filesystem::path& path)const{
    auto tmp=path;tmp+=".tmp";std::ofstream f(tmp,std::ios::binary);
    if(!f)throw std::runtime_error("Cannot write cache");
    f.write("CYIRR03\0",8);write(f,fingerprint);write(f,cell);uint64_t count=records.size();write(f,count);
    f.write((const char*)records.data(),records.size()*sizeof(IrradianceRecord));f.close();
    if(!f)throw std::runtime_error("Cannot write cache payload");
    std::error_code ec;std::filesystem::rename(tmp,path,ec);
    if(ec){std::filesystem::remove(path,ec);std::filesystem::rename(tmp,path);}
}
void IrradianceCache::load(const std::filesystem::path& path,uint64_t expected){
    std::ifstream f(path,std::ios::binary);if(!f)throw std::runtime_error("Missing cache "+path.string());
    char magic[8];f.read(magic,8);if(!f||std::memcmp(magic,"CYIRR03",7))throw std::runtime_error("Wrong cache format");
    read(f,fingerprint);if(fingerprint!=expected)throw std::runtime_error("Cache scene fingerprint mismatch");
    read(f,cell);uint64_t count;read(f,count);
    if(count>5000000||!std::isfinite(cell)||cell<=0)throw std::runtime_error("Invalid cache size");
    records.resize(count);f.read((char*)records.data(),count*sizeof(IrradianceRecord));
    if(!f)throw std::runtime_error("Truncated cache payload");
    index.clear();index.reserve(count*2);
    for(uint32_t i=0;i<count;i++){
        const auto&r=records[i];
        if(!finite(r.p)||!finite(r.n)||std::abs(length(r.n)-1)>.01f||r.key.axis>=6||r.key.group>3||r.twoSided>1||!finite(r.front.mean)||!finite(r.back.mean)||!std::isfinite(r.front.m2)||!std::isfinite(r.back.m2))throw std::runtime_error("Invalid irradiance record");
        index.emplace(r.key,i);
    }
    buildDenseIndex();
}
void IrradianceCache::report(const std::filesystem::path& path)const{
    std::vector<float> se;uint64_t paths=0,sideCount=0,pass=0;uint32_t minN=~0u,maxN=0;
    for(auto&r:records)for(auto*p:{&r.front,&r.back})if(p->n){
        float rel=p->standardError()/std::max(.03f,luminance(p->mean));se.push_back(rel);paths+=p->n;sideCount++;pass+=(1.96f*rel<=.04f);minN=std::min(minN,p->n);maxN=std::max(maxN,p->n);
    }
    std::ofstream f(path);f<<std::setprecision(9)
      <<"{\n\"method\":\"multi-bounce path-traced diffuse irradiance cache\",\n\"records\":"<<records.size()
      <<",\n\"hemisphere_records\":"<<sideCount<<",\n\"paths\":"<<paths<<",\n\"cell_metres\":"<<cell
      <<",\n\"min_samples\":"<<(sideCount?minN:0)<<",\n\"max_samples\":"<<maxN
      <<",\n\"normalized_standard_error_median\":"<<percentile(se,.5)
      <<",\n\"normalized_standard_error_p95\":"<<percentile(se,.95)
      <<",\n\"fraction_empirical_95pct_halfwidth_below_4pct\":"<<(sideCount?double(pass)/sideCount:0)
      <<",\n\"luminance_floor\":0.03,\n\"full_film_convergence_certified\":false,\n\"limitations\":\"Sampling estimates exclude spatial interpolation, simplified indirect Fresnel, omitted indirect glossy response and the separate volume approximation.\"\n}\n";
}
void VolumeGrid::build(const Integrator& original,int threads){
    fingerprint=original.scene.fingerprint;
    nx=int(std::ceil((hi.x-lo.x)/spacing))+1;ny=int(std::ceil((hi.y-lo.y)/spacing))+1;nz=int(std::ceil((hi.z-lo.z)/spacing))+1;
    solar.assign(size_t(nx)*ny*nz,0);auto start=std::chrono::steady_clock::now();
    parallel(nz,threads,[&](int z){for(int y=0;y<ny;y++)for(int x=0;x<nx;x++){
        size_t i=(size_t(z)*ny+y)*nx+x;V3 p{lo.x+x*spacing,lo.y+y*spacing,lo.z+z*spacing};RNG rng(seedAt(i,0,81231));float v=0;
        for(int k=0;k<4;k++){
            V3 d=cone(rng,original.lights.sun,std::cos(original.lights.sunRadius));Ray ray(p,d);
            if(!original.scene.occluded(ray))v+=original.lights.transmittance(ray);
        }
        solar[i]=v*.25f;
    }});
    std::cout<<"VOLUME sun_voxels="<<solar.size()<<" shadow_rays="<<solar.size()*4<<" seconds="<<seconds(start)<<'\n'<<std::flush;
    ax=(nx+5)/6;ay=(ny+5)/6;az=(nz+5)/6;ambient.resize(size_t(ax)*ay*az);
    Integrator in(original.scene);in.bark=original.bark;in.soil=original.soil;in.lights=original.lights;
    in.lights.extinction=0;in.maxDepth=original.maxDepth;in.includePrimarySun=false;
    parallel(az,threads,[&](int z){for(int y=0;y<ay;y++)for(int x=0;x<ax;x++){
        size_t i=(size_t(z)*ay+y)*ax+x;
        V3 p=lo+(hi-lo)*V3(float(x)/(ax-1),float(y)/(ay-1),float(z)/(az-1)),sum{};
        for(int k=0;k<128;k++){
            RNG rng(seedAt(i,k,90339));float zz=1-2*rng.uniform(),angle=2*Pi*rng.uniform(),r=std::sqrt(std::max(0.f,1-zz*zz));
            sum+=in.trace(Ray(p,{r*std::cos(angle),zz,r*std::sin(angle)}),rng);
        }
        ambient[i]=sum/128.f;
    }});
    std::cout<<"VOLUME ambient_probes="<<ambient.size()<<" paths="<<ambient.size()*128<<" seconds="<<seconds(start)<<'\n'<<std::flush;
}
namespace {
template<class T>T gridSample(const std::vector<T>& field,int nx,int ny,int nz,V3 f){
    f.x=clamp(f.x,0.f,float(nx-1)-1e-4f);f.y=clamp(f.y,0.f,float(ny-1)-1e-4f);f.z=clamp(f.z,0.f,float(nz-1)-1e-4f);
    int x=int(f.x),y=int(f.y),z=int(f.z);float u=f.x-x,v=f.y-y,w=f.z-z;
    auto at=[&](int dx,int dy,int dz){return field[(size_t(z+dz)*ny+y+dy)*nx+x+dx];};
    return mix(mix(mix(at(0,0,0),at(1,0,0),u),mix(at(0,1,0),at(1,1,0),u),v),mix(mix(at(0,0,1),at(1,0,1),u),mix(at(0,1,1),at(1,1,1),u),v),w);
}
}
float VolumeGrid::sun(V3 p)const{
    if(p.x<lo.x||p.y<lo.y||p.z<lo.z||p.x>hi.x||p.y>hi.y||p.z>hi.z)return 0;
    return gridSample(solar,nx,ny,nz,(p-lo)/spacing);
}
V3 VolumeGrid::indirect(V3 p)const{
    if(p.x<lo.x||p.y<lo.y||p.z<lo.z||p.x>hi.x||p.y>hi.y||p.z>hi.z)return {};
    return gridSample(ambient,ax,ay,az,(p-lo)/(hi-lo)*V3(ax-1,ay-1,az-1));
}
void VolumeGrid::save(const std::filesystem::path& path)const{
    std::ofstream f(path,std::ios::binary);if(!f)throw std::runtime_error("Cannot write volume");
    f.write("CYVOL02\0",8);write(f,fingerprint);write(f,lo);write(f,hi);write(f,spacing);
    write(f,nx);write(f,ny);write(f,nz);write(f,ax);write(f,ay);write(f,az);
    f.write((char*)solar.data(),solar.size()*sizeof(float));f.write((char*)ambient.data(),ambient.size()*sizeof(V3));
    if(!f)throw std::runtime_error("Volume write failed");
}
void VolumeGrid::load(const std::filesystem::path& path,uint64_t expected){
    std::ifstream f(path,std::ios::binary);if(!f)throw std::runtime_error("Cannot load volume");
    char magic[8];f.read(magic,8);if(!f||std::memcmp(magic,"CYVOL02",7))throw std::runtime_error("Invalid volume magic");
    read(f,fingerprint);if(fingerprint!=expected)throw std::runtime_error("Volume scene mismatch");
    read(f,lo);read(f,hi);read(f,spacing);read(f,nx);read(f,ny);read(f,nz);read(f,ax);read(f,ay);read(f,az);
    if(nx<2||ny<2||nz<2||nx>512||ny>512||nz>512||ax<2||ay<2||az<2||ax>128||ay>128||az>128||!finite(lo)||!finite(hi)||!std::isfinite(spacing)||spacing<=0)throw std::runtime_error("Invalid volume size");
    solar.resize(size_t(nx)*ny*nz);ambient.resize(size_t(ax)*ay*az);
    f.read((char*)solar.data(),solar.size()*sizeof(float));f.read((char*)ambient.data(),ambient.size()*sizeof(V3));
    if(!f)throw std::runtime_error("Truncated volume");
}
FrustumFog::FrustumFog(const Camera& camera,int width,int height,const VolumeGrid& grid,const Lighting& light,int threads):w((width+5)/6),h((height+5)/6),steps(160),step(1.0f),maxDistance(160){
    integral.resize(size_t(w)*h*(steps+1));FastCamera cam(camera,w,h);
    parallel(h,threads,[&](int y){for(int x=0;x<w;x++){
        Ray ray=cam.ray(x+.5f,y+.5f);float ph=phaseHG(dot(ray.d,light.sun),light.anisotropy);V3 sum{};float trans=1;
        size_t base=(size_t(y)*w+x)*(steps+1);integral[base]={};
        for(int k=1;k<=steps;k++){
            float a,b;Ray section(ray.o+ray.d*((k-1)*step),ray.d,0,step);
            if(light.volume.interval(section,a,b)&&b>a){
                float length=b-a;V3 p=section.o+ray.d*((a+b)*.5f);float tr=std::exp(-light.extinction*length);
                V3 source=light.irradiance*(ph*grid.sun(p))+grid.indirect(p);
                sum+=source*(light.volumeAlbedo*trans*(1-tr));trans*=tr;
            }
            integral[base+k]=sum;
        }
    }});
}
V3 FrustumFog::sample(float px,float py,float distance,int width,int height)const{
    float x=clamp(px/width*w-.5f,0.f,float(w-1)-1e-5f),y=clamp(py/height*h-.5f,0.f,float(h-1)-1e-5f),z=clamp(distance/step,0.f,float(steps)-1e-5f);
    int ix=int(x),iy=int(y),iz=int(z);float a=x-ix,b=y-iy,c=z-iz;
    auto at=[&](int dx,int dy,int dz){return integral[(size_t(iy+dy)*w+ix+dx)*(steps+1)+iz+dz];};
    return mix(mix(mix(at(0,0,0),at(1,0,0),a),mix(at(0,1,0),at(1,1,0),a),b),mix(mix(at(0,0,1),at(1,0,1),a),mix(at(0,1,1),at(1,1,1),a),b),c);
}
} // namespace cybr::cinema
