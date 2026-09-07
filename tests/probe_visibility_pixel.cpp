#include "cinema.hpp"
#include <iomanip>
using namespace cybr;using namespace cybr::cinema;
int main(int argc,char**argv){if(argc!=2)return 1;Scene scene;scene.load(std::filesystem::path(argv[1])/"forest.cys");FastCamera camera(cameraAt(0,.5f),640,360);auto tree=buildCameraTree(scene,camera);
int x=431,y=211;size_t i=size_t(y)*640+x;RNG offset(seedAt(i,0,981771));float rx=offset.uniform(),ry=offset.uniform();Hit aHint,bHint;
std::cout<<std::setprecision(12);
for(int s=0;s<8;s++){
float px=x+fract(rx+(s+.5f)*.7548776662f),py=y+fract(ry+(s+.5f)*.5698402910f);auto ray=camera.ray(px,py);Hit a,b;
bool ha=scene.intersectHint(ray,a,aHint),hb=scene.intersectHint(ray,b,bHint,&tree);aHint=a;bHint=b;
std::cout<<"SAMPLE "<<s<<" full="<<ha<<","<<a.instance<<","<<a.face<<","<<a.t<<","<<a.u<<","<<a.v<<" culled="<<hb<<","<<b.instance<<","<<b.face<<","<<b.t<<","<<b.u<<","<<b.v<<" fullInstanceRetained="<<(std::find(tree.indices.begin(),tree.indices.end(),a.instance)!=tree.indices.end())<<'\n';
}
}
