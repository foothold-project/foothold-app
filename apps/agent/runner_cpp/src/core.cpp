#include "foothold/core.hpp"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <stdexcept>
namespace foothold {
Joints to_policy(const Joints& v) {
    constexpr int order[]{3,0,9,6,4,1,10,7,5,2,11,8};
    Joints r{};for(int i=0;i<12;++i)r[i]=v[order[i]];return r;
}
Joints to_sdk(const Joints& v) {
    constexpr int order[]{1,5,9,0,4,8,3,7,11,2,6,10};
    Joints r{};for(int i=0;i<12;++i)r[i]=v[order[i]];return r;
}
Vec3 gravity(const Quat& q) {
    const double w=q[0],x=q[1],y=q[2],z=q[3];
    return {float(2*(w*y-x*z)),float(-2*(w*x+y*z)),float(-(1-2*(x*x+y*y)))};
}
Obs observation(const Vec3& gyro,const Vec3& grav,const Vec3& cmd,
                const Joints& q,const Joints& dq,const Joints& action) {
    Obs r{};
    for(int i=0;i<3;++i){r[i]=gyro[i];r[i+3]=grav[i];r[i+6]=cmd[i];}
    for(int i=0;i<12;++i){r[i+9]=q[i]-default_pose[i];r[i+21]=dq[i];r[i+33]=action[i];}
    return r;
}
Joints joint_targets(const Joints& action,bool bounded) {
    Joints r{};
    for(int i=0;i<12;++i){
        r[i]=default_pose[i]+.25f*std::clamp(action[i],-17.f,17.f);
        if(bounded)r[i]=std::clamp(r[i],default_pose[i]-target_span,default_pose[i]+target_span);
    }return r;
}
Remote parse_remote(const std::array<std::uint8_t,40>& b) {
    auto f=[&](int offset){
        std::uint32_t bits=0;for(int i=0;i<4;++i)bits|=std::uint32_t(b[offset+i])<<(8*i);
        float value;std::memcpy(&value,&bits,4);return value;
    };
    return {std::uint16_t(b[2]|(std::uint16_t(b[3])<<8)),f(4),f(20),f(8),f(12)};
}
Wanted remote_want(const Remote& r, double top) {
    auto lin=[](double v){v=std::clamp(v,-1.,1.);return std::abs(v)<.05?0.:v;};
    const double ly=lin(r.ly),x=ly*std::abs(ly);
    return {x * (x >= 0 ? top : 1.3), lin(-r.lx) * .8, lin(-r.rx) * 1.5};
}
bool remote_active(const Remote& r) {
    return r.keys || std::max({std::abs(r.lx),std::abs(r.ly),std::abs(r.rx)})>=.05;
}
const char* mark_name(Mark m) {
    switch(m){case Mark::clip:return "clip";case Mark::gap:return "gap";case Mark::interp:return "interp";default:return "none";}
}
Shaped shape_command(const Wanted& want, double top) {
    // Match Python's double arithmetic around float32 command boundaries.
    double v[3];for(int i=0;i<3;++i)v[i]=std::abs(want[i])<=.05?0.:want[i];
    Mark mark=Mark::none;
    if(.05<std::abs(v[0]) && std::abs(v[0])<.3-1e-4 && v[1]!=0){v[0]=std::copysign(.3,v[0]);mark=Mark::gap;}
    else if(.05<std::abs(v[0]) && std::abs(v[0])<.3-1e-4 && v[2]!=0){
        int k=0;for(int i=1;i<3;++i)if(std::abs(v[i])>std::abs(v[k]))k=i;
        for(int i=0;i<3;++i){if(i!=k)v[i]=0.;}mark=Mark::gap;
    }
    double x=std::min(std::clamp(v[0],-1.3,1.5),top);
    if(std::abs(x)>.6 && std::abs(v[1])>=.2){x=std::copysign(.6,x);mark=Mark::clip;}
    const double ax=std::abs(x),e=1e-4;
    const double ycap=x==0?.8:(.3-e<=ax && ax<=.6+e)?.5:ax>.6+e?0.:.8;
    const double y=std::clamp(v[1],-ycap,ycap);
    const double zcap=x==0 && y==0?1.5:x<0 || y!=0?.6:(.3-e<=x && x<=1.2+e)?1.:x>1.2+e?0.:1.5;
    const double z=std::clamp(v[2],-zcap,zcap);
    if(mark==Mark::none && (std::abs(x-v[0])>1e-6 || std::abs(y-v[1])>1e-6 || std::abs(z-v[2])>1e-6))mark=Mark::clip;
    if(mark==Mark::none && .3-e<=ax && ax<=.6+e && 0<std::abs(y) && std::abs(y)<.2)mark=Mark::interp;
    return {{float(x),float(y),float(z)},mark};
}
void slew_command(Vec3& current,const Vec3& goal) {
    constexpr double up[]{.5,.5,2.4},down[]{1.2,1.25,3.};
    constexpr double pos[]{.1,.1,.15},neg[]{.2,.1,.15};
    for(int i=0;i<3;++i){
        const bool slowing=std::abs(goal[i])<std::abs(current[i]) || current[i]*goal[i]<0;
        const double lim=(slowing?down:up)[i]*.02;
        current[i]=float(current[i]+std::clamp(double(goal[i]-current[i]),-lim,lim));
        const double floor=(goal[i]>0 || (goal[i]==0 && current[i]>0)?pos:neg)[i];
        const double c=current[i];
        if(std::abs(double(goal[i]))>=floor && std::abs(c)<floor && c*goal[i]>=0)current[i]=float(std::copysign(floor,goal[i]));
        else if(goal[i]==0 && 0<std::abs(c) && std::abs(c)<floor)current[i]=0;
    }
}
void Memory::reset(){step_=0;initialized_=false;inputs_=Inputs{};captured_.fill(0);}
bool Memory::update_map(bool depth_available) {
    if (mode_ != MapMode::automatic || depth_enabled_ == depth_available) return false;
    depth_enabled_ = depth_available;
    reset();
    return true;
}
bool Memory::depth_needed()const{return depth_enabled_ && (!initialized_ || step_%5==0);}
const Inputs& Memory::prepare(const Obs& obs,const Depth* frame,const HeightMap* gt) {
    if(depth_enabled_ && !initialized_ && !frame)
        throw std::invalid_argument("reconstruction needs the first depth frame");
    inputs_.obs=obs;
    if(!initialized_)for(int i=0;i<10;++i)std::copy(obs.begin(),obs.end(),inputs_.hist.begin()+45*i);
    else {std::copy_backward(inputs_.hist.begin(),inputs_.hist.begin()+405,inputs_.hist.end());std::copy(obs.begin(),obs.end(),inputs_.hist.begin());}
    inputs_.depth_tick=step_%5==0;inputs_.first_after_reset=step_==0;inputs_.use_gt=mode_==MapMode::gt;
    inputs_.gt_map=inputs_.use_gt && gt?*gt:HeightMap{};
    inputs_.pose = pose_;
    inputs_.map_mask = !depth_enabled_;
    if (mode_ == MapMode::automatic && !depth_enabled_ && !initialized_)
        inputs_.depth2.fill(1.f);
    if(depth_enabled_){
        if(!initialized_){captured_=*frame;std::copy(frame->begin(),frame->end(),inputs_.depth2.begin());std::copy(frame->begin(),frame->end(),inputs_.depth2.begin()+3600);}
        else if(inputs_.depth_tick){std::copy_n(inputs_.depth2.begin(),3600,inputs_.depth2.begin()+3600);std::copy(captured_.begin(),captured_.end(),inputs_.depth2.begin());}
        if(frame && inputs_.depth_tick && step_!=0)captured_=*frame;
    }
    initialized_=true;return inputs_;
}
void Memory::advance(const std::array<float,128>& hp,const std::array<float,128>& ht){inputs_.h_prop=hp;inputs_.h_terr=ht;++step_;}
}
