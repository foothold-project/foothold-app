#pragma once

#include "foothold/core.hpp"

#include <chrono>
#include <optional>

namespace foothold {

using Tick = std::chrono::steady_clock::time_point;
enum class Phase { high, acquiring, folding, standing, policy, sitting, dog_sitting, moving, damping, returning, recovering };
// Factory moves replayed inside START (same keys as the factory remote).
enum class Move { dog_sit, dog_rise, stretch, shake_hands, love, greet };
enum class RobotMode { low, factory, unknown };
enum class Gait { none, free_walk, classic };
enum class Event {
    mode_low, stand_fold, stand_refused, policy_start, sit_down, damping, liveness_lost, depth_lost, robot_fall,
    robot_fall_recovery_stand, factory_handover, mode_high, mode_high_retry,
    mode_high_failed, mode_low_failed, factory_gait, exit_sit_down,
    inference_failed, ame2_unavailable, depth_stale, runner_ready, mode_rpc, dog_sit, dog_rise, factory_move, move_fall,
    app_key, app_drop, handover_refused
};
const char* event_name(Event event);
const char* phase_name(Phase phase);

struct Battery {
    float soc, voltage, current;
    std::array<int, 2> bq_ntc, mcu_ntc;
};

struct LowState {
    Tick stamp{};
    Quat orientation{1, 0, 0, 0};
    Vec3 gyro{};
    Joints q{}, dq{}, tau{}, temperature{};
    std::array<float, 4> foot{};
    Remote remote;
    std::optional<Battery> battery;
    // App velocity from the local channel (app_input.hpp). Used in place of the stick only
    // while the physical remote is neutral; expires like a deadman.
    std::optional<Wanted> app_want;
};
struct Estimate {
    float raw_vx;
    Vec3 velocity;
};

struct Outputs {
    Joints action{};
    std::array<float, 128> h_prop{}, h_terr{};
    HeightMap recon{};
    std::optional<Estimate> estimate;
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
    // Position + velocity targets with a torque feed-forward (factory move replay).
    // hip_kp applies to the four hip joints (SDK indices 0, 3, 6, 9).
    virtual void send_ff(const Joints& q_sdk, const Joints& dq_sdk, const Joints& tau_sdk, float kp, float kd,
                         float hip_kp) {
        (void)dq_sdk;
        (void)tau_sdk;
        (void)hip_kp;
        send(q_sdk, kp, kd);
    }
};
enum class ModeCall { check_acquire, release_factory, select_factory, confirm_factory, recovery_stand, select_gait };

struct ModeRequest {
    ModeCall call;
    Gait gait = Gait::none;
};

struct ModeResult {
    RobotMode mode = RobotMode::unknown;
    bool succeeded = false;
    double duration_ms = 0;
};

ModeResult execute_mode(Robot&, ModeRequest);

class ModeExecutor {
public:
    virtual ~ModeExecutor() = default;
    virtual void submit(ModeRequest) = 0;
    virtual std::optional<ModeResult> poll() = 0;
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
    Phase phase = Phase::policy;
    std::optional<Estimate> estimate = std::nullopt;
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

// A depth frame with its capture time (CLOCK_MONOTONIC). values is nullptr when the
// reader has nothing fresh; stamp is then ignored.
struct DepthFrame {
    const Depth* values = nullptr;
    Tick stamp{};
};

struct Options {
    bool live = false;
    MapMode map = MapMode::off;
    // Reconstruction depth gap rule (lead-lx draft 11/27, sim evidence only, real values after G4).
    // Without a new frame the policy holds h_terr (no depth tick). From depth_slow_after the
    // command goal is zero (slow to a stop); from depth_sit_after the runner sits (DEPTH_LOST).
    std::chrono::milliseconds depth_slow_after{1000}, depth_sit_after{3000};
    // A frame whose share of invalid cells (1.0 after the 60x60 resize) is above this is
    // ignored: no tick, and the gap clock keeps running (lead-lx 11/27 17:52, sim: 0.4 holds,
    // 0.8 drops balance-beam survival below 1/3).
    float depth_max_invalid = 0.4f;
    double fwd_max = 1.5;
    bool stand_only = false;
};

// One caller owns the state machine and every command. No holder can race a mode change.
class Runner {
public:
    Runner(Robot&, PolicyExecutor&, Observer&, Options = {}, ModeExecutor* = nullptr);
    void tick(Tick, const LowState&, DepthFrame, bool shutdown = false,
              std::optional<Tick> scheduled = std::nullopt);
    // A frame passed here counts as captured at `now` (replay and tests).
    void tick(Tick now, const LowState& state, const Depth* frame = nullptr, bool shutdown = false,
              std::optional<Tick> scheduled = std::nullopt) {
        tick(now, state, DepthFrame{frame, now}, shutdown, scheduled);
    }
    Phase phase() const { return phase_; }
    Move move() const { return move_; }
    // Why the last tick refused a key (static string) or nullptr. Read right after tick().
    const char* refusal() const { return refusal_; }
    bool stopped() const { return stopped_; }
    std::uint64_t commands() const { return commands_; }
    std::uint64_t policy_steps() const { return policy_steps_; }

private:
    void send(const Joints&, float position_gain, float velocity_gain);
    void damp(Tick, const char* reason);
    void start(Tick, const Joints&, const Vec3& gravity);
    void sit(Tick, const Joints&, bool blind);
    void acquire(Tick, const Joints&, bool interrupted = false);
    std::optional<ModeResult> mode_step(Tick, ModeCall, Gait = Gait::none);
    void return_to_factory(Tick);
    void advance_return(Tick);
    void complete_return(Tick);
    void recover_gait(Tick);
    void collect(Tick);
    void infer(Tick, Tick, const LowState&, const Vec3&, const Joints&, DepthFrame);
    void send_transition(Tick, const LowState&, const Vec3& gravity, const Joints&, float kp, float kd);
    void fold(Tick, const LowState&, const Vec3& gravity);
    void interpolate(Tick, Tick, const LowState&, const Vec3& gravity, bool standing);
    void enter_policy(Tick, Tick scheduled);
    void run_move(Tick, Tick, const LowState&, const Vec3& gravity);
    void begin_move(Tick, Move, const Joints&);

    Robot& robot_;
    PolicyExecutor& policy_;
    Observer& observer_;
    Options options_;
    ModeExecutor* modes_;
    std::optional<ModeCall> mode_pending_;
    Memory memory_;
    Phase phase_ = Phase::high;
    Gait gait_ = Gait::none;
    bool restand_ = false, fall_recovery_ = false, return_after_sit_ = false, blind_sit_ = false;
    bool lie_latched_ = false, ame2_latched_ = false, move_latched_ = false, handover_latched_ = false;
    const char* refusal_ = nullptr;
    std::optional<Tick> still_since_;
    Move move_ = Move::dog_sit;
    bool shutdown_ = false, stopped_ = false, confirm_return_ = false;
    bool abort_acquire_ = false, recovery_stand_pending_ = false;
    int attempts_ = 0;
    Tick started_{}, deadline_{}, next_attempt_{}, next_policy_{};
    std::optional<Tick> stale_since_, fall_since_;
    Tick depth_seen_{}, depth_used_{};
    bool depth_slowed_ = false;
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
    unsigned transition_ticks_ = 0;
};

}
