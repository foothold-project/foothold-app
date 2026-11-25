#pragma once
#include <array>
#include <cstdint>

namespace foothold {
using Vec3 = std::array<float, 3>;
using Wanted = std::array<double, 3>;
using Quat = std::array<float, 4>;
using Joints = std::array<float, 12>;
using Obs = std::array<float, 45>;
using Depth = std::array<float, 3600>;
using HeightMap = std::array<float, 512>;
constexpr Joints default_pose{.1f,-.1f,.1f,-.1f,.8f,.8f,1,1,-1.5f,-1.5f,-1.5f,-1.5f};
constexpr Joints sit_pose{.06f, -.06f, .34f, -.34f, 1.24f, 1.24f, 1.29f, 1.29f,
                          -2.78f, -2.78f, -2.82f, -2.82f};
constexpr float kp=25.f, kd=.5f, target_span=1.6f;
enum class Mark { none, clip, gap, interp };
enum class MapMode { off, reconstruction, gt };
struct Remote { std::uint16_t keys{}; float lx{}, ly{}, rx{}, ry{}; };
struct Shaped { Vec3 command{}; Mark mark{}; };
Joints to_policy(const Joints&);
Joints to_sdk(const Joints&);
Vec3 gravity(const Quat&);
Obs observation(const Vec3&,const Vec3&,const Vec3&,const Joints&,const Joints&,const Joints&);
Joints joint_targets(const Joints&, bool bounded=true);
Remote parse_remote(const std::array<std::uint8_t,40>&);
Wanted remote_want(const Remote&, double fwd_max = 1.5);
bool remote_active(const Remote&);
Shaped shape_command(const Wanted&, double fwd_max = 1.5);
void slew_command(Vec3& current,const Vec3& goal);
const char* mark_name(Mark);
struct Inputs {
    Obs obs{};
    std::array<float,450> hist{};
    std::array<float,7200> depth2{};
    std::array<float,128> h_prop{},h_terr{};
    HeightMap gt_map{};
    bool depth_tick{}, first_after_reset{}, use_gt{};
};
class Memory {
public:
    explicit Memory(MapMode mode):mode_(mode){}
    void reset();
    bool depth_needed()const;
    const Inputs& prepare(const Obs&,const Depth* frame=nullptr,const HeightMap* gt=nullptr);
    void advance(const std::array<float,128>&,const std::array<float,128>&);
    std::uint64_t step()const{return step_;}
private:
    MapMode mode_;
    std::uint64_t step_{};
    bool initialized_{};
    Inputs inputs_{};
    Depth captured_{};
};
}
