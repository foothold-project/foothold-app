#pragma once
#include <array>
#include <cstdint>

namespace foothold {
using Vec3 = std::array<float, 3>;
using Wanted = std::array<double, 3>;
using Quat = std::array<float, 4>;
using Joints = std::array<float, 12>;
using Obs = std::array<float, 45>;
using Pose = std::array<float, 2>;
using Depth = std::array<float, 3600>;
using HeightMap = std::array<float, 512>;
constexpr Joints default_pose{.1f,-.1f,.1f,-.1f,.8f,.8f,1,1,-1.5f,-1.5f,-1.5f,-1.5f};
constexpr Joints sit_pose{0,0,0,0,1.2f,1.2f,1.2f,1.2f,-2.7f,-2.7f,-2.7f,-2.7f};
constexpr float kp=25.f, kd=.5f, target_span=1.6f;
enum class Mark { none, clip, gap, interp };
enum class MapMode { off, reconstruction, gt, automatic };
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
    Pose pose{};
    bool depth_tick{}, first_after_reset{}, use_gt{}, map_mask{true};
};
class Memory {
public:
    explicit Memory(MapMode mode, Pose pose = {}) : mode_(mode), pose_(pose), depth_enabled_(mode == MapMode::reconstruction) {}
    void reset();
    bool update_map(bool depth_available);
    bool depth_needed()const;
    const Inputs& prepare(const Obs&,const Depth* frame=nullptr,const HeightMap* gt=nullptr);
    void advance(const std::array<float,128>&,const std::array<float,128>&);
    std::uint64_t step()const{return step_;}
private:
    MapMode mode_;
    std::uint64_t step_{};
    Pose pose_;
    bool initialized_{}, depth_enabled_;
    Inputs inputs_{};
    Depth captured_{};
};
}
