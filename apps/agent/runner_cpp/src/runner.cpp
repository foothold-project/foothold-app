#include "foothold/runner.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

using namespace std::chrono_literals;

namespace foothold {
namespace {
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

template<class Range>
bool finite(const Range& values) {
    return std::all_of(values.begin(), values.end(), [](float v) { return std::isfinite(v); });
}
}

const char* event_name(Event event) {
    switch (event) {
    case Event::mode_low: return "MODE_LOW";
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
    }
    return "UNKNOWN";
}

Runner::Runner(Robot& robot, PolicyExecutor& policy, Observer& observer, Options options)
    : robot_(robot), policy_(policy), observer_(observer), options_(options), memory_(options.map) {
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

void Runner::start(Tick now, const Joints& q) {
    pending_sample_.reset();
    return_after_sit_ = false;
    phase_ = Phase::acquiring;
    deadline_ = now + 10s;
    next_attempt_ = now;
    acquire(now, q);
}

void Runner::acquire(Tick now, const Joints& q) {
    if (now < next_attempt_) return;
    auto mode = options_.live ? robot_.check_mode() : RobotMode::low;
    if (mode == RobotMode::factory && now < deadline_) {
        robot_.release_mode();
        mode = robot_.check_mode();
    }
    if (mode == RobotMode::low) {
        observer_.event(now, Event::mode_low);
        from_ = q;
        started_ = now;
        phase_ = Phase::standing;
    } else if (now >= deadline_) {
        phase_ = Phase::high;
        observer_.event(now, Event::mode_low_failed);
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

void Runner::interpolate(Tick now, Tick scheduled, bool standing) {
    const auto elapsed = seconds(now - started_);
    const auto fraction = std::clamp(elapsed / (standing ? 2.5 : 2.0), 0., 1.);
    const auto smooth = float(fraction * fraction * (3 - 2 * fraction));
    const auto& destination = standing ? default_pose : sit_pose;
    Joints pose{};
    for (std::size_t i = 0; i < pose.size(); ++i)
        pose[i] = from_[i] + (destination[i] - from_[i]) * smooth;
    const auto blend = float(std::clamp(elapsed - 2.5, 0., 1.));
    send(pose, standing ? 60 + (kp - 60) * blend : kp,
         standing ? 5 + (kd - 5) * blend : kd);
    if (standing && elapsed >= 3.5) {
        memory_.reset();
        last_action_.fill(0);
        command_.fill(0);
        target_ = default_pose;
        next_policy_ = scheduled + 20ms;
        fall_since_.reset();
        phase_ = Phase::policy;
        observer_.event(now, Event::policy_start, {options_.map == MapMode::off ? "off" : "reconstruction"});
    } else if (!standing && elapsed >= 2.) {
        damp(now, "sat down");
        if (return_after_sit_) {
            if (gait_ != Gait::none) observer_.event(now, Event::factory_handover, {gait_ == Gait::free_walk ? "free_walk" : "classic"});
            return_to_factory(now);
        }
    }
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
    if (!options_.live || (confirm_return_ && robot_.check_mode() == RobotMode::factory)) {
        complete_return(now);
        return;
    }
    if (confirm_return_) observer_.event(now, Event::mode_high_retry);
    if (attempts_ >= 5) {
        observer_.event(now, Event::mode_high_failed);
        phase_ = Phase::damping;
        return_after_sit_ = false;
        gait_ = Gait::none;
        fall_recovery_ = false;
        if (shutdown_) stopped_ = true;
        return;
    }
    ++attempts_;
    if (!robot_.select_mode()) robot_.check_mode();
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
    if (fall_recovery_ || gait_ != Gait::none) {
        if (options_.live) robot_.recovery_stand();
        if (fall_recovery_) observer_.event(now, Event::robot_fall_recovery_stand);
    }
    fall_recovery_ = false;
    if (gait_ == Gait::none) return;
    if (options_.live) {
        phase_ = Phase::recovering;
        attempts_ = 0;
        next_attempt_ = now + 3s;
    } else {
        observer_.event(now, Event::factory_gait);
        gait_ = Gait::none;
    }
}

void Runner::recover_gait(Tick now) {
    if (now < next_attempt_) return;
    ++attempts_;
    if (robot_.select_gait(gait_) || attempts_ == 3) {
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
                      sample.shaped.command, command_, sample.shaped.mark, target_});
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
    const bool active = phase_ == Phase::standing || phase_ == Phase::policy;
    const auto q = to_policy(state.q);
    const auto grav = gravity(state.orientation);
    const bool stale = state.stamp == Tick{} || now - state.stamp > 50ms;
    const bool invalid = !finite(q) || !finite(grav);
    if (!lie) lie_latched_ = false;

    // The worker may finish after a safety transition. Drain that result without
    // applying it before submitting work from a new policy session.
    if (!pending_sample_) collect(now);

    if (phase_ == Phase::returning) {
        advance_return(now);
        return;
    }
    if (phase_ == Phase::recovering) {
        if (shutdown_) { stopped_ = true; return; }
        recover_gait(now);
        return;
    }
    if (shutdown_ && phase_ == Phase::high) { stopped_ = true; return; }

    if ((active || phase_ == Phase::sitting) && (emergency || invalid)) {
        damp(now, emergency ? "remote L2+B" : "invalid LowState");
        if (return_after_sit_ || shutdown_) return_to_factory(now);
        return;
    }
    if (phase_ == Phase::sitting) {
        if (stale && !blind_sit_) {
            damp(now, "sit interrupted by stale LowState");
            if (return_after_sit_ || shutdown_) return_to_factory(now);
        } else {
            if (shutdown_) return_after_sit_ = true;
            interpolate(now, scheduled, false);
        }
        return;
    }
    if (shutdown_) {
        if (active) {
            observer_.event(now, Event::exit_sit_down);
            return_after_sit_ = true;
            sit(now, q, stale);
        } else if (phase_ == Phase::damping || phase_ == Phase::acquiring) {
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

    if (phase_ == Phase::standing && stale) {
        damp(now, "stand-up interrupted");
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
    if (stale || invalid) {
        if (phase_ == Phase::acquiring) {
            if (now >= deadline_) return_to_factory(now);
        }
        return;
    }
    if (phase_ == Phase::acquiring) {
        acquire(now, q);
        return;
    }
    if (phase_ == Phase::policy && grav[2] > -.5f) {
        if (!fall_since_) fall_since_ = now;
        if (now - *fall_since_ >= 500ms) {
            damp(now, "fall");
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
        if (phase_ == Phase::damping) { start(now, q); return; }
        if (active) { sit(now, q, false); return; }
    }
    if ((phase_ == Phase::high || phase_ == Phase::damping) &&
        pressed(keys, start_button | up_button)) {
        start(now, q);
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
    if (phase_ == Phase::standing) {
        interpolate(now, scheduled, true);
        return;
    }
    if (phase_ == Phase::policy) {
        collect(now);
        if (phase_ == Phase::policy) infer(now, scheduled, state, grav, q, frame);
        if (phase_ == Phase::policy) send(target_, kp, kd);
    }
}

}
