#include "lightcache.hpp"
using namespace cybr;using namespace cybr::cinema;
int main(int argc,char**argv){try{
    if(argc<3)throw std::runtime_error("cybr-cache ASSETS [gather|bake|volume] [MAX_SAMPLES=4096] [THREADS=4]");
    std::filesystem::path assets=argv[1];std::string mode=argv[2];int samples=argc>3?std::stoi(argv[3]):4096,threads=argc>4?std::stoi(argv[4]):4;
    if(samples<512||samples>1000000||threads<1||threads>128)throw std::runtime_error("Invalid samples or threads");
    Scene scene;scene.load(assets/"forest.cys");Integrator in(scene);in.bark.load(assets/"bark.tex");in.soil.load(assets/"soil.tex");in.maxDepth=16;
    if(mode=="gather"){
        IrradianceCache cache;cache.cell=1;cache.gather(in,0,11,12,threads);cache.save(assets/"forest.irr");
    }else if(mode=="bake"){
        IrradianceCache cache;cache.load(assets/"forest.irr",scene.fingerprint);cache.build(in,512,samples,.04f,threads,assets/"forest.irr");
    }else if(mode=="volume"){
        VolumeGrid grid;grid.build(in,threads);grid.save(assets/"forest.vol");
    }else throw std::runtime_error("Unknown mode");
}catch(const std::exception&e){std::cerr<<"ERROR "<<e.what()<<'\n';return 1;}return 0;}
