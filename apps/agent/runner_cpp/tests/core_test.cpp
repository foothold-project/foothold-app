#include "foothold/core.hpp"
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <stdexcept>
using namespace foothold;
void check(bool yes,const char* name){if(!yes){std::cerr<<"FAIL "<<name<<'\n';std::exit(1);}}
bool close(float a,float b){return std::abs(a-b)<1e-6f;}
int main(){
 Joints sdk{};for(int i=0;i<12;i++)sdk[i]=float(i);
 check(to_policy(sdk)==Joints{3,0,9,6,4,1,10,7,5,2,11,8},"SDK to policy ordering");
 check(to_sdk(to_policy(sdk))==sdk,"inverse joint order");
 check(gravity({1,0,0,0})==Vec3{0,0,-1},"upright gravity");
 auto o=observation({1,2,3},{0,0,-1},{.1f,.2f,.3f},default_pose,sdk,sdk);
 check(o[0]==1 && o[5]==-1 && o[8]==.3f && o[9]==0 && o[32]==11 && o[44]==11,"obs45 order and scale");
 Joints a{};a.fill(100);auto q=joint_targets(a);
 check(close(q[0],default_pose[0]+1.6f),"target span after clip");
 check(close(joint_targets(a,false)[0],default_pose[0]+4.25f),"action clip17 scale0.25");
 check(remote_want(Remote{0,0,1,0,0},1.2)==Wanted{1.2,0,0},"fwd max");
 check(close(remote_want(Remote{0,0,.5f,0,0})[0],.375f),"quadratic forward");
 check(shape_command({.05, .6, .15}).mark == Mark::none, "exact gap boundary is zero");
 check(shape_command({1.5f,.8f,1.5f}).command==Vec3{.6f,.5f,.6f},"fast diagonal preserves side");
 check(shape_command({.1f,.4f,0}).command==Vec3{.3f,.4f,0},"diagonal gap raises x");
 check(shape_command({.1f,0,.4f}).command==Vec3{0,0,.4f},"turn gap largest axis");
 Vec3 c{};slew_command(c,{.5f,.5f,.5f});check(c==Vec3{.1f,.1f,.15f},"floor skip at departure");
 slew_command(c,{});check(c==Vec3{},"floor skip on stop");
 Memory m(MapMode::reconstruction);Depth f{};f.fill(.2f);Obs obs{};obs[0]=1;
 check(m.depth_needed(),"first depth required");
 bool caught=false;try{m.prepare(obs);}catch(const std::invalid_argument&){caught=true;}
 check(caught,"missing first depth rejected");
 auto& in=m.prepare(obs,&f);check(in.first_after_reset && in.depth_tick && in.hist[405]==1 && in.depth2[0]==.2f && in.depth2[3600]==.2f,"initial input buffers");
 std::array<float,128> h{};h.fill(.125f);
 for(int step=1;step<=10;step++){
  m.advance(h,h);obs[0]=float(step+1);f.fill(step==5?.7f:.9f);
  auto& x=m.prepare(obs,step%5==0?&f:nullptr);
  check(x.obs[0]==step+1 && x.hist[45]==step && x.h_prop[0]==.125f,"history and GRU feed back");
  check(x.depth2[0]==(step<10?.2f:.7f),"depth capture delayed one tick");
 }
 // Hold. Slot 15 still ticks (frame captured on slot 10 is pending); slot 20 has nothing new.
 auto run=[&](int from,int to,const Depth* at_last){const Inputs* x=nullptr;
  for(int step=from;step<=to;step++){m.advance(h,h);x=&m.prepare(obs,step==to?at_last:nullptr);}return *x;};
 auto h1=run(11,15,nullptr);check(h1.depth_tick && h1.depth2[0]==.9f && h1.depth2[3600]==.7f,"pending frame enters on the next slot");
 auto h2=run(16,20,nullptr);check(!h2.depth_tick && h2.depth2[0]==.9f && h2.depth2[3600]==.7f,"no new frame holds depth2 without a tick");
 f.fill(.4f);auto h3=run(21,25,&f);check(!h3.depth_tick && h3.depth2[0]==.9f,"frame after a hold waits one slot");
 auto h4=run(26,30,nullptr);check(h4.depth_tick && h4.depth2[0]==.4f && h4.depth2[3600]==.9f,"held frame enters on the next slot");
 m.reset();check(m.step()==0 && m.depth_needed(),"reset all recurrent state");
 Memory off(MapMode::off);check(off.prepare(obs,&f).depth2[0]==0 && !off.depth_needed(),"off depth zero");
 Memory gt(MapMode::gt);HeightMap map{};map.fill(.31f);
 check(gt.prepare(obs,nullptr,&map).use_gt && gt.prepare(obs,nullptr,&map).gt_map[0]==.31f,"GT benchmark input");
 std::cout<<"PASS core contract\n";
}
