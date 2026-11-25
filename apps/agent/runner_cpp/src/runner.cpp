#include "foothold/runner.hpp"
#include "foothold/moves_dog_sit.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

using namespace std::chrono_literals;

namespace foothold {
namespace {
constexpr int r1_button = 1 << 0;
constexpr int l1_button = 1 << 1;
constexpr int r2_button = 1 << 4;
constexpr int y_button = 1 << 11;
constexpr int start_button = 1 << 2;
constexpr int l2_button = 1 << 5;
constexpr int a_button = 1 << 8;
constexpr int b_button = 1 << 9;
constexpr int up_button = 1 << 12;
constexpr int right_button = 1 << 13;
constexpr int down_button = 1 << 14;
constexpr int left_button = 1 << 15;

bool pressed(std::uint16_t keys, int mask) { return (keys & mask) == mask; }
double seconds(Tick::duration span) { return std::chrono::duration<double>(span).count(); }

using Window = std::array<double, 2>;
using Windows = std::array<Window, 4>;

// Policy order: front hips, rear hips, thighs, calves.
constexpr Windows sit_windows{{{.5, 1.}, {.25, 1.}, {0., .97}, {0., .95}}};
constexpr Windows stand_windows{{{0., .95}, {.28, .92}, {.42, .98}, {.46, 1.}}};
constexpr Windows fold_windows{{{0., 1.}, {0., 1.}, {0., 1.}, {0., 1.}}};

Joints blend_pose(const Joints& from, const Joints& to, double fraction, const Windows& windows) {
    Joints pose{};
    for (std::size_t i = 0; i < pose.size(); ++i) {
        const auto& [lo, hi] = windows[i < 4 ? i / 2 : 1 + i / 4];
        if (fraction >= hi) {
            pose[i] = to[i];
        } else {
            const auto x = std::max(0., (fraction - lo) / (hi - lo));
            pose[i] = static_cast<float>(from[i] + (double(to[i]) - from[i]) * (x * x * (3 - 2 * x)));
        }
    }
    return pose;
}

// R1+B dog sit timing in seconds (same key as the factory Sit Down). Recorded segments play
// at their original speed. Before the sit, the feet step to the factory stance in two diagonal
// taps (FL+RR, then FR+RL), as the factory controller does (11/26 factory trace 06:27:27).
constexpr double dog_tap = .14;       // one diagonal pair: lift and place
constexpr double dog_tap_gap = .02;   // pause before the second pair
constexpr double dog_align = .46;     // taps done and settled -> first recorded sit row
constexpr double dog_tap_thigh = .23; // swing lift at mid tap (factory trace)
constexpr double dog_tap_calf = .42;
constexpr double dog_blend = .3;      // held sit pose -> first recorded rise row
// Recorded factory torque is fed forward at this fraction on top of Kp 60 / Kd 5 tracking of the
// recorded q and dq (11/26: position-only replay could not lift a loaded foot). Start at half.
constexpr double move_tau_scale = .5;
constexpr float tau_limit_hip_thigh = 20.f, tau_limit_calf = 35.f;  // Go2 motor peaks 23.7 / 45.4 Nm
constexpr auto move_fall_hold = std::chrono::milliseconds(300);
constexpr double dog_settle = .5;     // last rise row -> default_pose
constexpr double dog_gain_ramp = 1.;  // transition gains -> policy gains, as at the end of stand-up

Joints lerp(const Joints& from, const Joints& to, double fraction);
double smoothstep(double x);

// Two diagonal taps from the current stance to the first recorded sit row. Policy joint order:
// hip, thigh, calf, each FL FR RL RR.
Joints tap_pose(const Joints& from, const Joints& to, double t) {
    Joints pose = from;
    for (std::size_t leg = 0; leg < 4; ++leg) {
        const double begin = (leg == 0 || leg == 3) ? 0. : dog_tap + dog_tap_gap;
        const double x = std::clamp((t - begin) / dog_tap, 0., 1.);
        const double lift = std::sin(3.14159265358979 * x);
        for (std::size_t j = leg; j < pose.size(); j += 4)
            pose[j] = static_cast<float>(from[j] + (double(to[j]) - from[j]) * smoothstep(x));
        pose[4 + leg] = static_cast<float>(pose[4 + leg] + dog_tap_thigh * lift);
        pose[8 + leg] = static_cast<float>(pose[8 + leg] - dog_tap_calf * lift);
    }
    return pose;
}

Joints lerp(const Joints& from, const Joints& to, double fraction) {
    Joints pose{};
    for (std::size_t i = 0; i < pose.size(); ++i)
        pose[i] = static_cast<float>(from[i] + (double(to[i]) - from[i]) * fraction);
    return pose;
}

double smoothstep(double x) {
    x = std::clamp(x, 0., 1.);
    return x * x * (3 - 2 * x);
}

struct Frame {
    Joints q, dq, tau;
};

// Linear interpolation of a 50 Hz recording at any time; holds the ends outside it.
Frame play(const MoveRow* first, std::size_t count, double t) {
    const auto* last = first + count - 1;
    if (t <= first->t) return {first->q, first->dq, first->tau};
    if (t >= last->t) return {last->q, Joints{}, last->tau};
    const auto* next = std::upper_bound(first, last, t, [](double v, const MoveRow& f) { return v < f.t; });
    const auto* prev = next - 1;
    const double x = (t - prev->t) / (next->t - prev->t);
    return {lerp(prev->q, next->q, x), lerp(prev->dq, next->dq, x), lerp(prev->tau, next->tau, x)};
}

struct MoveSpec {
    const char* name;
    const MoveRow* taps;  // factory tap torque for the lead-in (q is synthesized), or null for a blend
    std::size_t tap_count;
    const MoveRow* body;
    std::size_t count;
    bool hold;            // dog sit: hold the last row until the next press
    float fall_gz;        // gravity z above this for move_fall_hold = fall (recorded range + margin)
    double tau_scale;     // fraction of the recorded torque fed forward
    float hip_kp;         // hip position gain (thigh and calf stay at Kp 60)
};

template <std::size_t N, std::size_t M>
constexpr MoveSpec spec(const char* name, const std::array<MoveRow, N>* taps, const std::array<MoveRow, M>& body,
                        bool hold, float fall_gz, double tau_scale = move_tau_scale, float hip_kp = 60) {
    return {name, taps ? taps->data() : nullptr, taps ? N : 0, body.data(), M, hold, fall_gz, tau_scale, hip_kp};
}

MoveSpec move_spec(Move move) {
    switch (move) {
    case Move::dog_sit: return spec("DOG_SIT", &dog_taps, dog_sit_down, true, -.35f);
    // 11/26 07:31: half torque let the FL hip sag under the 3-leg shake (fell left twice) and the
    // rise roll 0.21 while the front feet stepped. These two use full recorded torque and hip Kp 100.
    case Move::dog_rise: return spec<1>("DOG_RISE", nullptr, dog_rise, false, -.35f, 1., 100);
    case Move::stretch: return spec("STRETCH", &dog_taps, stretch_body, false, -.5f);
    case Move::shake_hands: return spec("SHAKE_HANDS", &dog_taps, shake_body, false, -.5f, 1., 100);
    case Move::love: return spec("LOVE", &dog_taps, love_body, false, .55f);
    case Move::greet: return spec("GREET", &dog_taps, greet_body, false, .55f);
    }
    return spec("DOG_SIT", &dog_taps, dog_sit_down, true, -.35f);
}

Joints scaled_tau(const Joints& tau, double scale) {
    Joints out{};
    for (std::size_t i = 0; i < out.size(); ++i) {
        const float limit = i < 8 ? tau_limit_hip_thigh : tau_limit_calf;
        out[i] = std::clamp(static_cast<float>(tau[i] * scale), -limit, limit);
    }
    return out;
}

const char* mode_name(ModeCall call) {
    switch (call) {
    case ModeCall::check_acquire: return "check_acquire";
    case ModeCall::release_factory: return "release_factory";
    case ModeCall::select_factory: return "select_factory";
    case ModeCall::confirm_factory: return "confirm_factory";
    case ModeCall::recovery_stand: return "recovery_stand";
    case ModeCall::select_gait: return "select_gait";
    }
    return "unknown";
}

template<class Range>
bool finite(const Range& values) {
    return std::all_of(values.begin(), values.end(), [](float v) { return std::isfinite(v); });
}
}

const char* event_name(Event event) {
    switch (event) {
    case Event::mode_rpc: return "MODE_RPC";
    case Event::runner_ready: return "RUNNER_READY";
    case Event::mode_low: return "MODE_LOW";
    case Event::stand_fold: return "STAND_FOLD";
    case Event::stand_refused: return "STAND_REFUSED";
    case Event::policy_start: return "POLICY_START";
    case Event::sit_down: return "SIT_DOWN";
    case Event::damping: return "DAMPING";
    case Event::liveness_lost: return "LIVENESS_LOST";
    case Event::depth_lost: return "DEPTH_LOST";
    case Event::robot_fall: return "ROBOT_FALL";
    case Event::robot_fall_recovery_stand: return "ROBOT_FALL_RECOVERY_STAND";
    case Event::factory_handover: return "FACTORY_HANDOVER";
    case Event::mode_high: return "MODE_HIGH";
    case Event::mode_high_retry: return "MODE_HIGH_RETRY";
    case Event::mode_high_failed: return "MODE_HIGH_FAILED";
    case Event::mode_low_failed: return "MODE_LOW_FAILED";
    case Event::factory_gait: return "FACTORY_GAIT";
    case Event::exit_sit_down: return "EXIT_SIT_DOWN";
    case Event::inference_failed: return "INFERENCE_FAILED";
    case Event::ame2_unavailable: return "AME2_UNAVAILABLE";
    case Event::dog_sit: return "DOG_SIT";
    case Event::dog_rise: return "DOG_RISE";
    case Event::factory_move: return "FACTORY_MOVE";
    case Event::move_fall: return "MOVE_FALL";
    }
    return "UNKNOWN";
}

ModeResult execute_mode(Robot& robot, ModeRequest request) {
    const auto started = std::chrono::steady_clock::now();
    ModeResult result;
    switch (request.call) {
    case ModeCall::check_acquire:
    case ModeCall::confirm_factory:
        result.mode = robot.check_mode();
        break;
    case ModeCall::release_factory:
        robot.release_mode();
        result.mode = robot.check_mode();
        break;
    case ModeCall::select_factory:
        result.succeeded = robot.select_mode();
        if (!result.succeeded) result.mode = robot.check_mode();
        break;
    case ModeCall::recovery_stand:
        robot.recovery_stand();
        result.succeeded = true;
        break;
    case ModeCall::select_gait:
        result.succeeded = robot.select_gait(request.gait);
        break;
    }
    result.duration_ms = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - started).count();
    return result;
}

Runner::Runner(Robot& robot, PolicyExecutor& policy, Observer& observer, Options options, ModeExecutor* modes)
    : robot_(robot), policy_(policy), observer_(observer), options_(options), modes_(modes), memory_(options.map) {
    if (options_.live && !modes_) throw std::invalid_argument("live runner requires a mode executor");
    if (!std::isfinite(options_.fwd_max)) throw std::invalid_argument("fwd_max must be finite");
    options_.fwd_max = std::clamp(options_.fwd_max, 0., 1.5);
    if (options_.live && options_.map == MapMode::gt)
        throw std::invalid_argument("ground truth map mode is for replay");
}

void Runner::send(const Joints& q, float position_gain, float velocity_gain) {
    if (options_.live) robot_.send(to_sdk(q), position_gain, velocity_gain);
    ++commands_;
}

void Runner::damp(Tick now, const char* reason) {
    pending_sample_.reset();
    phase_ = Phase::damping;
    send(Joints{}, 0, 3);
    observer_.event(now, Event::damping, {reason});
}

void Runner::start(Tick now, const Joints& q, const Vec3& grav) {
    restand_ = phase_ == Phase::damping;
    if (restand_) {
        constexpr double degrees_per_radian = 57.29577951308232;
        const auto tilt = std::acos(std::clamp(-double(grav[2]), -1., 1.)) * degrees_per_radian;
        if (tilt > 25.) {
            observer_.event(now, Event::stand_refused, {"tilted", tilt});
            return;
        }
    }
    pending_sample_.reset();
    return_after_sit_ = false;
    phase_ = Phase::acquiring;
    abort_acquire_ = false;
    deadline_ = now + 10s;
    next_attempt_ = now;
    acquire(now, q);
}

std::optional<ModeResult> Runner::mode_step(Tick now, ModeCall call, Gait gait) {
    if (!mode_pending_) {
        modes_->submit({call, gait});
        mode_pending_ = call;
    }
    if (*mode_pending_ != call) throw std::logic_error("unexpected pending mode operation");
    auto result = modes_->poll();
    if (result) {
        mode_pending_.reset();
        observer_.event(now, Event::mode_rpc, {mode_name(call), result->duration_ms});
    }
    return result;
}

void Runner::acquire(Tick now, const Joints& q, bool interrupted) {
    abort_acquire_ |= interrupted || now >= deadline_;
    if (!mode_pending_ && abort_acquire_) {
        observer_.event(now, Event::mode_low_failed);
        return_to_factory(now);
        return;
    }
    if (now < next_attempt_) return;
    const auto operation = mode_pending_.value_or(ModeCall::check_acquire);
    auto result = options_.live ? mode_step(now, operation)
                                : std::optional<ModeResult>{ModeResult{RobotMode::low}};
    if (result && result->mode == RobotMode::factory && !abort_acquire_ &&
        operation == ModeCall::check_acquire)
        result = mode_step(now, ModeCall::release_factory);
    if (!result) return;
    if (result->mode == RobotMode::low) {
        observer_.event(now, Event::mode_low);
        if (abort_acquire_) {
            damp(now, "acquire interrupted");
            return_to_factory(now);
            return;
        }
        from_ = q;
        started_ = now;
        // Already sitting (L2+A sit): stand straight up. Fold only from a flat damped pose.
        float sit_gap = 0.f;
        for (std::size_t i = 0; i < q.size(); ++i) sit_gap = std::max(sit_gap, std::abs(q[i] - sit_pose[i]));
        const bool fold = restand_ && sit_gap > .25f;
        phase_ = fold ? Phase::folding : Phase::standing;
        if (fold) observer_.event(now, Event::stand_fold, {nullptr, 1.});
    } else if (abort_acquire_) {
        observer_.event(now, Event::mode_low_failed);
        if (result->mode == RobotMode::factory) complete_return(now);
        else return_to_factory(now);
    } else {
        next_attempt_ = now + 500ms;
    }
}

void Runner::sit(Tick now, const Joints& q, bool blind) {
    pending_sample_.reset();
    phase_ = Phase::sitting;
    from_ = q;
    started_ = now;
    blind_sit_ = blind;
    observer_.event(now, Event::sit_down);
}

void Runner::send_transition(Tick now, const LowState& state, const Vec3& grav,
                             const Joints& pose, float position_gain, float velocity_gain) {
    send(pose, position_gain, velocity_gain);
    // Commands run at 200 Hz. Record every fourth successful transition command.
    if (++transition_ticks_ % 4 == 0)
        observer_.sample({now, state, grav, {}, {}, {}, Mark::none, pose, phase_});
}

void Runner::fold(Tick now, const LowState& state, const Vec3& grav) {
    const auto fraction = std::clamp(seconds(now - started_), 0., 1.);
    send_transition(now, state, grav, blend_pose(from_, sit_pose, fraction, fold_windows), 60, 5);
    if (fraction < 1.) return;
    from_ = sit_pose;
    started_ = now;
    phase_ = Phase::standing;
}

void Runner::interpolate(Tick now, Tick scheduled, const LowState& state, const Vec3& grav,
                         bool standing) {
    const auto elapsed = seconds(now - started_);
    const auto fraction = std::clamp(elapsed / (standing ? 2.5 : 2.0), 0., 1.);
    const auto& destination = standing ? default_pose : sit_pose;
    const auto pose = blend_pose(from_, destination, fraction, standing ? stand_windows : sit_windows);
    const auto blend = standing ? float(std::clamp(elapsed - 2.5, 0., 1.)) : 0.f;
    send_transition(now, state, grav, pose, 60 + (kp - 60) * blend, 5 + (kd - 5) * blend);
    if (standing && elapsed >= 3.5) {
        enter_policy(now, scheduled);
    } else if (!standing && elapsed >= 2.) {
        damp(now, "sat down");
        if (return_after_sit_) {
            if (gait_ != Gait::none) observer_.event(now, Event::factory_handover, {gait_ == Gait::free_walk ? "free_walk" : "classic"});
            return_to_factory(now);
        }
    }
}

void Runner::enter_policy(Tick now, Tick scheduled) {
    memory_.reset();
    last_action_.fill(0);
    command_.fill(0);
    target_ = default_pose;
    next_policy_ = scheduled + 20ms;
    fall_since_.reset();
    phase_ = Phase::policy;
    observer_.event(now, Event::policy_start, {options_.map == MapMode::off ? "off" : "reconstruction"});
}

// Factory move replay (same keys as the factory remote). From policy: two diagonal taps to the
// recorded first row (q synthesized, factory tap torque fed forward), then the recorded q / dq with
// scaled recorded torque. Dog sit holds its last row; R1+B again plays the recorded rise. Every
// other move (and the rise) settles to default_pose, ramps to policy gains and resumes the policy.
void Runner::begin_move(Tick now, Move move, const Joints& q) {
    pending_sample_.reset();
    fall_since_.reset();
    move_ = move;
    phase_ = (move == Move::dog_sit || move == Move::dog_rise) ? Phase::dog_sitting : Phase::moving;
    from_ = q;
    started_ = now;
    const auto event = move == Move::dog_sit ? Event::dog_sit : move == Move::dog_rise ? Event::dog_rise
                                                                                        : Event::factory_move;
    observer_.event(now, event, {move_spec(move).name, move_tau_scale});
}

void Runner::run_move(Tick now, Tick scheduled, const LowState& state, const Vec3& grav) {
    const auto spec = move_spec(move_);
    const double lead = spec.taps ? dog_align : dog_blend;
    const double played = lead + spec.body[spec.count - 1].t;
    const auto t = seconds(now - started_);
    Frame frame{};
    double gain = 0;
    if (t < lead) {
        frame.q = spec.taps ? tap_pose(from_, spec.body[0].q, t) : lerp(from_, spec.body[0].q, smoothstep(t / dog_blend));
        if (spec.taps) frame.tau = play(spec.taps, spec.tap_count, t).tau;
    } else if (spec.hold || t < played) {
        frame = play(spec.body, spec.count, t - lead);
    } else {
        const auto settle = t - played;
        frame.q = lerp(spec.body[spec.count - 1].q, default_pose, smoothstep(settle / dog_settle));
        frame.tau = lerp(spec.body[spec.count - 1].tau, Joints{}, smoothstep(settle / dog_settle));
        gain = std::clamp((settle - dog_settle) / dog_gain_ramp, 0., 1.);
    }
    const auto tau = scaled_tau(frame.tau, spec.tau_scale * (1 - gain));
    const auto position_gain = float(60 + (kp - 60) * gain), velocity_gain = float(5 + (kd - 5) * gain);
    const auto hip_gain = float(spec.hip_kp + (kp - spec.hip_kp) * gain);
    if (options_.live)
        robot_.send_ff(to_sdk(frame.q), to_sdk(frame.dq), to_sdk(tau), position_gain, velocity_gain, hip_gain);
    ++commands_;
    if (++transition_ticks_ % 4 == 0)
        observer_.sample({now, state, grav, {}, {}, {}, Mark::none, frame.q, phase_});
    if (!spec.hold && t >= played + dog_settle + dog_gain_ramp) enter_policy(now, scheduled);
}

void Runner::return_to_factory(Tick now) {
    phase_ = Phase::returning;
    attempts_ = 0;
    confirm_return_ = false;
    next_attempt_ = now;
    advance_return(now);
}

void Runner::advance_return(Tick now) {
    if (now < next_attempt_) return;
    if (!options_.live) {
        complete_return(now);
        return;
    }
    if (confirm_return_) {
        const auto result = mode_step(now, ModeCall::confirm_factory);
        if (!result) return;
        if (result->mode == RobotMode::factory) {
            complete_return(now);
            return;
        }
        confirm_return_ = false;
        observer_.event(now, Event::mode_high_retry);
    }
    if (attempts_ >= 5) {
        observer_.event(now, Event::mode_high_failed);
        phase_ = Phase::damping;
        return_after_sit_ = false;
        gait_ = Gait::none;
        fall_recovery_ = false;
        if (shutdown_) stopped_ = true;
        return;
    }
    if (!mode_step(now, ModeCall::select_factory)) return;
    ++attempts_;
    confirm_return_ = true;
    next_attempt_ = now + 1s;
}

void Runner::complete_return(Tick now) {
    phase_ = Phase::high;
    return_after_sit_ = false;
    observer_.event(now, Event::mode_high);
    if (shutdown_) {
        stopped_ = true;
        return;
    }
    if (options_.live && (fall_recovery_ || gait_ != Gait::none)) {
        phase_ = Phase::recovering;
        recovery_stand_pending_ = true;
        attempts_ = 0;
        next_attempt_ = now;
        recover_gait(now);
        return;
    }
    if (fall_recovery_) observer_.event(now, Event::robot_fall_recovery_stand);
    fall_recovery_ = false;
    if (gait_ != Gait::none) {
        observer_.event(now, Event::factory_gait);
        gait_ = Gait::none;
    }
}

void Runner::recover_gait(Tick now) {
    if (shutdown_) {
        if (mode_pending_ && !mode_step(now, *mode_pending_, gait_)) return;
        stopped_ = true;
        return;
    }
    if (now < next_attempt_) return;
    if (recovery_stand_pending_) {
        const auto result = mode_step(now, ModeCall::recovery_stand);
        if (!result) return;
        recovery_stand_pending_ = false;
        if (fall_recovery_ && result->succeeded) observer_.event(now, Event::robot_fall_recovery_stand);
        fall_recovery_ = false;
        if (gait_ == Gait::none) phase_ = Phase::high;
        else next_attempt_ = now + 3s;
        return;
    }
    const auto result = mode_step(now, ModeCall::select_gait, gait_);
    if (!result) return;
    ++attempts_;
    if (result->succeeded || attempts_ == 3) {
        phase_ = Phase::high;
        gait_ = Gait::none;
        observer_.event(now, Event::factory_gait);
    } else {
        next_attempt_ = now + 1s;
    }
}

void Runner::collect(Tick now) {
    if (!inference_pending_) return;
    const auto result = policy_.poll(outputs_);
    if (result == Inference::pending) return;
    inference_pending_ = false;
    if (!pending_sample_) return;
    const auto sample = *pending_sample_;
    pending_sample_.reset();
    if (result == Inference::failed || !finite(outputs_.action) ||
        !finite(outputs_.h_prop) || !finite(outputs_.h_terr)) {
        observer_.event(now, Event::inference_failed);
        damp(now, "inference failed");
        return;
    }
    memory_.advance(outputs_.h_prop, outputs_.h_terr);
    last_action_ = outputs_.action;
    target_ = joint_targets(last_action_);
    observer_.sample({sample.time, sample.state, sample.gravity, sample.want,
                      sample.shaped.command, command_, sample.shaped.mark, target_,
                      Phase::policy, outputs_.estimate});
}

void Runner::infer(Tick now, Tick scheduled, const LowState& state, const Vec3& grav,
                   const Joints& q, const Depth* frame) {
    if (scheduled < next_policy_ || options_.stand_only) return;
    next_policy_ += 20ms;
    if (next_policy_ <= scheduled) next_policy_ = scheduled + 20ms;
    if (inference_pending_) return;
    const auto want = remote_want(state.remote, options_.fwd_max);
    const auto shaped = shape_command(want, options_.fwd_max);
    slew_command(command_, shaped.command);
    const auto dq = to_policy(state.dq);
    const auto obs = observation(state.gyro, grav, command_, q, dq, last_action_);
    try {
        if (!finite(obs) || (frame && !finite(*frame)))
            throw std::runtime_error("nonfinite policy input");
        policy_.submit(memory_.prepare(obs, memory_.depth_needed() ? frame : nullptr));
    } catch (const std::exception&) {
        observer_.event(now, Event::inference_failed);
        damp(now, "inference failed");
        return;
    }
    ++policy_steps_;
    pending_sample_ = PendingSample{now, state, grav, want, shaped};
    inference_pending_ = true;
    collect(now);
}

void Runner::tick(Tick now, const LowState& state, const Depth* frame, bool shutdown,
                  std::optional<Tick> scheduled_slot) {
    const auto scheduled = scheduled_slot.value_or(now);
    if (stopped_) return;
    shutdown_ = shutdown_ || shutdown;
    const auto keys = state.remote.keys;
    const bool emergency = pressed(keys, l2_button | b_button);
    const bool lie = pressed(keys, l2_button | a_button);
    // Factory remote keys. Each move key is exactly the factory combination (no other trigger held),
    // so L2+B (damp) and L2+A (lie down) never start a move.
    const auto only = [&](int mask) { return (keys & (mask | l2_button | l1_button | r1_button | r2_button)) == mask; };
    std::optional<Move> move_key;
    if (only(r1_button | b_button)) move_key = Move::dog_sit;
    else if (only(r2_button | a_button)) move_key = Move::stretch;
    else if (only(r2_button | b_button)) move_key = Move::shake_hands;
    else if (only(r2_button | y_button)) move_key = Move::love;
    else if (only(l1_button | a_button)) move_key = Move::greet;
    const bool standing_up = phase_ == Phase::folding || phase_ == Phase::standing;
    const bool moving = phase_ == Phase::dog_sitting || phase_ == Phase::moving;
    const bool active = standing_up || phase_ == Phase::policy || moving;
    const auto q = to_policy(state.q);
    const auto grav = gravity(state.orientation);
    const bool stale = state.stamp == Tick{} || now - state.stamp > 50ms;
    const bool invalid = !finite(q) || !finite(grav);
    if (!lie) lie_latched_ = false;
    if (!move_key) move_latched_ = false;

    // The worker may finish after a safety transition. Drain that result without
    // applying it before submitting work from a new policy session.
    if (!pending_sample_) collect(now);

    if (phase_ == Phase::returning) {
        advance_return(now);
        return;
    }
    if (phase_ == Phase::recovering) {
        recover_gait(now);
        return;
    }
    if (phase_ == Phase::acquiring) {
        acquire(now, q, shutdown_ || emergency || stale || invalid ||
                        (options_.map == MapMode::reconstruction && !frame));
        return;
    }
    if (shutdown_ && phase_ == Phase::high) { stopped_ = true; return; }

    if ((active || phase_ == Phase::sitting) && (emergency || invalid)) {
        const auto* reason = phase_ == Phase::folding ? "fold interrupted" :
                             emergency ? "remote L2+B" : "invalid LowState";
        damp(now, reason);
        if (return_after_sit_ || shutdown_) return_to_factory(now);
        return;
    }
    if (phase_ == Phase::sitting) {
        if (stale && !blind_sit_) {
            damp(now, "sit interrupted by stale LowState");
            if (return_after_sit_ || shutdown_) return_to_factory(now);
        } else {
            if (shutdown_) return_after_sit_ = true;
            interpolate(now, scheduled, state, grav, false);
        }
        return;
    }
    if (shutdown_) {
        if (active) {
            observer_.event(now, Event::exit_sit_down);
            return_after_sit_ = true;
            sit(now, q, stale);
        } else if (phase_ == Phase::damping) {
            return_to_factory(now);
        }
        return;
    }
    if (emergency) return;

    // Fresh depth is required to arm reconstruction. Loss during policy uses
    // the same controlled sit and mode return as a lost LowState stream.
    if (options_.map == MapMode::reconstruction && !frame) {
        if (active) {
            observer_.event(now, Event::depth_lost);
            return_after_sit_ = true;
            sit(now, q, stale);
            return;
        }
        if (phase_ == Phase::high || phase_ == Phase::damping) return;
    }

    if (moving && stale) {
        damp(now, "factory move interrupted by stale LowState");
        return;
    }
    if (standing_up && stale) {
        damp(now, phase_ == Phase::folding ? "fold interrupted" : "stand-up interrupted");
        return;
    }
    if (phase_ == Phase::policy && stale) {
        if (!stale_since_) stale_since_ = now;
        if (now - *stale_since_ >= 1s) {
            observer_.event(now, Event::liveness_lost, {nullptr, seconds(now - *stale_since_)});
            return_after_sit_ = true;
            sit(now, q, true);
        } else {
            send(target_, kp, kd);
        }
        return;
    }
    stale_since_.reset();
    if (stale || invalid) return;
    if (phase_ == Phase::policy && grav[2] > -.5f) {
        if (!fall_since_) fall_since_ = now;
        if (now - *fall_since_ >= 500ms) {
            damp(now, "fall");
            observer_.event(now, Event::robot_fall, {nullptr, grav[2]});
            fall_recovery_ = true;
            return_to_factory(now);
            return;
        }
    } else if (moving && (grav[2] > move_spec(move_).fall_gz || std::abs(grav[1]) > .7f)) {
        if (!fall_since_) fall_since_ = now;
        if (now - *fall_since_ >= move_fall_hold) {
            damp(now, "fall during factory move");
            observer_.event(now, Event::move_fall, {move_spec(move_).name, grav[2]});
            observer_.event(now, Event::robot_fall, {nullptr, grav[2]});
            fall_recovery_ = true;
            return_to_factory(now);
            return;
        }
    } else {
        fall_since_.reset();
    }

    if (lie && !lie_latched_) {
        lie_latched_ = true;
        if (phase_ == Phase::damping) { start(now, q, grav); return; }
        // While standing up, L2+A is ignored (L2+B still damps). Sit only from policy.
        if (phase_ == Phase::policy) { sit(now, q, false); return; }
    }
    if (move_key && !move_latched_) {
        move_latched_ = true;
        // Moves start only from policy. R1+B rises from a held dog sit. Presses during motion are dropped.
        const bool holding = phase_ == Phase::dog_sitting && move_ == Move::dog_sit &&
                             seconds(now - started_) >= dog_align + dog_sit_down.back().t;
        if (phase_ == Phase::policy) begin_move(now, *move_key, q);
        else if (holding && *move_key == Move::dog_sit) begin_move(now, Move::dog_rise, q);
    }
    if (phase_ == Phase::dog_sitting || phase_ == Phase::moving) {
        run_move(now, scheduled, state, grav);
        return;
    }
    if ((phase_ == Phase::high || phase_ == Phase::damping) &&
        pressed(keys, start_button | up_button)) {
        start(now, q, grav);
        return;
    }
    if (pressed(keys, start_button | down_button)) {
        if (!ame2_latched_) observer_.event(now, Event::ame2_unavailable);
        ame2_latched_ = true;
        if (phase_ == Phase::policy) send(target_, kp, kd);
        return;
    }
    ame2_latched_ = false;
    if (phase_ == Phase::policy || phase_ == Phase::damping) {
        if (pressed(keys, start_button | left_button) || pressed(keys, start_button | right_button)) {
            gait_ = pressed(keys, left_button) ? Gait::free_walk : Gait::classic;
            if (phase_ == Phase::policy) {
                return_after_sit_ = true;
                sit(now, q, false);
            } else {
                observer_.event(now, Event::factory_handover, {gait_ == Gait::free_walk ? "free_walk" : "classic"});
                return_to_factory(now);
            }
            return;
        }
    }
    if (phase_ == Phase::folding) {
        fold(now, state, grav);
        return;
    }
    if (phase_ == Phase::standing) {
        interpolate(now, scheduled, state, grav, true);
        return;
    }
    if (phase_ == Phase::policy) {
        collect(now);
        if (phase_ == Phase::policy) infer(now, scheduled, state, grav, q, frame);
        if (phase_ == Phase::policy) send(target_, kp, kd);
    }
}

}
