#pragma once

#include "foothold/core.hpp"

#include <chrono>
#include <optional>

namespace foothold {

using Tick = std::chrono::steady_clock::time_point;
enum class Phase { high, acquiring, folding, standing, policy, sitting, damping, returning, recovering };
enum class RobotMode { low, factory, unknown };
enum class Gait { none, free_walk, classic };
enum class Event {
    mode_low, stand_fold, stand_refused, policy_start, map_changed, sit_down, damping, liveness_lost, depth_lost, robot_fall,
    robot_fall_recovery_stand, factory_handover, mode_high, mode_high_retry,
    mode_high_failed, mode_low_failed, factory_gait, exit_sit_down,
    inference_failed, ame2_unavailable
};
const char* event_name(Event event);

struct LowState {
    Tick stamp{};
    Quat orientation{1, 0, 0, 0};
    Vec3 gyro{};
    Joints q{}, dq{}, tau{}, temperature{};
    std::array<float, 4> foot{};
    Remote remote;
};
struct Outputs {
    Joints action{};
    std::array<float, 128> h_prop{}, h_terr{};
    HeightMap recon{};
    std::array<float, 51> est{};
};

class Robot {
public:
    virtual ~Robot() = default;
    virtual RobotMode check_mode() = 0;
    virtual void release_mode() = 0;
    virtual bool select_mode() = 0;
    virtual void recovery_stand() = 0;
    virtual bool select_gait(Gait) = 0;
    virtual void send(const Joints& q_sdk, float kp, float kd) = 0;
};
class Policy {
public:
    virtual ~Policy() = default;
    virtual void infer(const Inputs&, Outputs&) = 0;
};

enum class Inference { pending, ready, failed };

class PolicyExecutor {
public:
    virtual ~PolicyExecutor() = default;
    virtual void submit(const Inputs&) = 0;
    virtual Inference poll(Outputs&) = 0;
};

struct Sample {
    Tick time;
    const LowState& state;
    Vec3 gravity;
    Wanted want;
    Vec3 goal, command;
    Mark shape;
    const Joints& target;
};

struct EventInfo {
    const char* text = nullptr;
    double value = 0;
};

class Observer {
public:
    virtual ~Observer() = default;
    virtual void event(Tick, Event, EventInfo = {}) {}
    virtual void sample(const Sample&) {}
};

struct Options {
    bool live = false;
    MapMode map = MapMode::off;
    double fwd_max = 1.5;
    bool stand_only = false;
    Pose pose{};
};

// One caller owns the state machine and every command. No holder can race a mode change.
class Runner {
public:
    Runner(Robot&, PolicyExecutor&, Observer&, Options = {});
    void tick(Tick, const LowState&, const Depth* = nullptr, bool shutdown = false,
              std::optional<Tick> scheduled = std::nullopt);
    Phase phase() const { return phase_; }
    bool stopped() const { return stopped_; }
    std::uint64_t commands() const { return commands_; }
    std::uint64_t policy_steps() const { return policy_steps_; }

private:
    void send(const Joints&, float position_gain, float velocity_gain);
    void damp(Tick, const char* reason);
    void start(Tick, const Joints&, const Vec3& gravity);
    void sit(Tick, const Joints&, bool blind);
    void acquire(Tick, const Joints&);
    void return_to_factory(Tick);
    void advance_return(Tick);
    void complete_return(Tick);
    void recover_gait(Tick);
    void collect(Tick);
    void infer(Tick, Tick, const LowState&, const Vec3&, const Joints&, const Depth*);
    void fold(Tick);
    void interpolate(Tick, Tick, bool standing);

    Robot& robot_;
    PolicyExecutor& policy_;
    Observer& observer_;
    Options options_;
    Memory memory_;
    Phase phase_ = Phase::high;
    Gait gait_ = Gait::none;
    bool restand_ = false, fall_recovery_ = false, return_after_sit_ = false, blind_sit_ = false;
    bool lie_latched_ = false, ame2_latched_ = false;
    bool shutdown_ = false, stopped_ = false, confirm_return_ = false;
    int attempts_ = 0;
    Tick started_{}, deadline_{}, next_attempt_{}, next_policy_{};
    std::optional<Tick> stale_since_, fall_since_;
    Joints from_{}, target_ = default_pose, last_action_{};
    Vec3 command_{};
    struct PendingSample {
        Tick time;
        LowState state;
        Vec3 gravity;
        Wanted want;
        Shaped shaped;
    };
    std::optional<PendingSample> pending_sample_;
    bool inference_pending_ = false;
    Outputs outputs_{};
    std::uint64_t commands_ = 0, policy_steps_ = 0;
};

}
