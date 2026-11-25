#include "foothold/moves_dog_sit.hpp"
#include "foothold/runner.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <string_view>
#include <vector>

using namespace foothold;
using namespace std::chrono_literals;

namespace {
constexpr auto start = (1 << 12) | (1 << 2);
constexpr auto lie = (1 << 5) | (1 << 8);
constexpr auto emergency = (1 << 5) | (1 << 9);
constexpr auto classic = (1 << 13) | (1 << 2);
constexpr auto dog = (1 << 5) | (1 << 11);

float distance(const Joints& a, const Joints& b) {
    float gap = 0;
    for (std::size_t i = 0; i < a.size(); ++i) gap = std::max(gap, std::abs(a[i] - b[i]));
    return gap;
}

void require(bool valid, std::string_view message) {
    if (!valid) {
        std::cerr << message << '\n';
        std::exit(1);
    }
}

struct FakeRobot final : Robot {
    bool factory = true, attach_on_select = true, acknowledge_select = true;
    int writes = 0, calls = 0, recovery = 0, gaits = 0;
    float position_gain = 0, velocity_gain = 0;
    Joints last_target{};

    RobotMode check_mode() override {
        ++calls;
        return factory ? RobotMode::factory : RobotMode::low;
    }
    void release_mode() override { ++calls; factory = false; }
    bool select_mode() override {
        ++calls;
        if (attach_on_select) factory = true;
        return acknowledge_select;
    }
    void recovery_stand() override { ++calls; ++recovery; }
    bool select_gait(Gait) override { ++calls; ++gaits; return true; }
    void send(const Joints& q, float p, float d) override {
        require(!factory, "LowCmd and factory control overlapped");
        ++writes;
        last_target = q;
        position_gain = p;
        velocity_gain = d;
    }
};

struct FakeModes final : ModeExecutor {
    explicit FakeModes(FakeRobot& robot) : robot(robot) {}
    FakeRobot& robot;
    std::optional<ModeRequest> pending;
    bool delayed = false;
    std::optional<ModeCall> delayed_call;
    void submit(ModeRequest request) override {
        require(!pending, "overlapping mode RPCs");
        pending = request;
    }
    std::optional<ModeResult> poll() override {
        if (!pending || delayed || pending->call == delayed_call) return std::nullopt;
        const auto request = *pending;
        pending.reset();
        return execute_mode(robot, request);
    }
};

struct FakePolicy final : PolicyExecutor {
    float next_action = 1;
    int calls = 0;
    bool delayed = false;
    Outputs result;
    void submit(const Inputs& in) override {
        require(in.obs[33] == (calls == 0 || in.first_after_reset ? 0 : 1),
                "previous action missing from observation");
        ++calls;
        result.action.fill(next_action);
    }
    Inference poll(Outputs& out) override {
        if (delayed) return Inference::pending;
        out = result;
        return Inference::ready;
    }
};

struct Events final : Observer {
    std::vector<Event> seen;
    std::vector<Tick> samples;
    void sample(const Sample& sample) override { samples.push_back(sample.time); }
    void event(Tick, Event event, EventInfo) override { seen.push_back(event); }
    bool ordered(std::initializer_list<Event> sequence) const {
        auto cursor = seen.begin();
        for (const auto event : sequence) {
            cursor = std::find(cursor, seen.end(), event);
            if (cursor == seen.end()) return false;
            ++cursor;
        }
        return true;
    }
};

struct Rig {
    FakeRobot robot;
    FakeModes modes{robot};
    FakePolicy policy;
    Events events;
    Runner runner;
    LowState state;
    Tick time{};
    const Depth* depth = nullptr;

    explicit Rig(bool live, MapMode mode = MapMode::off) : runner(robot, policy, events, {live, mode}, &modes) {
        state.q = to_sdk(sit_pose);
    }
    void tick(int keys = 0, bool fresh = true, bool shutdown = false) {
        time += 5ms;
        if (fresh) state.stamp = time;
        state.remote.keys = keys;
        runner.tick(time, state, depth, shutdown);
    }
    void wait(std::chrono::milliseconds duration, int keys = 0, bool fresh = true) {
        for (int i = 0; i < duration / 5ms; ++i) tick(keys, fresh);
    }
    void enter() {
        tick(start);
        wait(3500ms);
        require(runner.phase() == Phase::policy, "stand and blend did not enter policy");
    }
};
}

int main() {
    {
        Rig live(true);
        live.modes.delayed = true;
        live.tick(start);
        live.wait(150ms);
        require(live.runner.phase() == Phase::acquiring && live.robot.calls == 0 && live.robot.writes == 0,
                "pending acquire must leave the command loop responsive without writing");
        live.tick(emergency);
        live.modes.delayed = false;
        live.tick();
        require(live.runner.phase() == Phase::high && live.robot.factory && live.robot.calls == 1 &&
                    live.robot.writes == 0,
                "emergency during mode check must prevent release even after the button is released");
    }
    {
        Rig live(true);
        live.modes.delayed_call = ModeCall::release_factory;
        live.tick(start);
        live.wait(150ms);
        require(live.runner.phase() == Phase::acquiring && live.robot.writes == 0,
                "pending release must prevent pose writes");
        live.tick(emergency);
        live.modes.delayed_call.reset();
        live.tick();
        require(live.runner.phase() == Phase::returning && live.robot.position_gain == 0,
                "emergency during release must damp and restore factory mode");
        live.wait(1s);
        require(live.runner.phase() == Phase::high && live.robot.factory,
                "interrupted acquire did not restore factory mode");
    }
    {
        Rig live(true);
        live.enter();
        live.tick(emergency);
        live.modes.delayed = true;
        const auto before = live.robot.writes;
        live.tick(0, true, true);
        live.wait(150ms);
        require(live.runner.phase() == Phase::returning && !live.runner.stopped() && live.robot.writes == before,
                "shutdown must wait without writing while factory selection is pending");
        live.modes.delayed = false;
        live.tick();
        live.wait(1s);
        require(live.runner.stopped() && live.robot.factory, "shutdown must confirm factory mode");
    }
    {
        Rig live(true);
        live.tick(start);
        live.wait(1s);
        const auto standing = to_policy(live.robot.last_target);
        require(standing[0] != sit_pose[0] && standing[4] == sit_pose[4],
                "stand must move the front hips before the thighs");
        require(live.events.samples.size() == 50, "stand must record at 50 Hz");
        for (std::size_t i = 1; i < live.events.samples.size(); ++i)
            require(live.events.samples[i] - live.events.samples[i - 1] == 20ms,
                    "stand record interval must be 20 ms");
        live.wait(2500ms);
        live.state.q = to_sdk(default_pose);
        live.tick(lie);
        live.events.samples.clear();
        live.wait(400ms);
        const auto sitting = to_policy(live.robot.last_target);
        require(sitting[0] == default_pose[0] && sitting[4] != default_pose[4],
                "sit must move the thighs before the front hips");
        require(live.robot.position_gain == 60 && live.robot.velocity_gain == 5,
                "sit gains must match Python");
        require(live.events.samples.size() == 20, "sit must record at 50 Hz");
        live.tick(emergency);
        require(live.robot.position_gain == 0 && live.robot.velocity_gain == 3,
                "emergency must override sit gains");
        live.wait(40ms);
        require(live.events.samples.size() == 20, "interrupted sit must stop recording transition targets");
    }
    {
        Rig dry(false);
        dry.tick(emergency);
        require(dry.runner.phase() == Phase::high, "emergency chord in factory belongs to firmware");
        dry.enter();
        dry.wait(100ms);
        require(dry.policy.calls == 5, "expected five policy ticks in 100 ms");
        dry.tick(lie);
        dry.wait(2s, lie);
        require(dry.runner.phase() == Phase::damping, "L2+A must latch while held");
        dry.tick();
        dry.tick(lie);
        dry.wait(4500ms);
        require(dry.runner.phase() == Phase::policy, "resting recovery did not return to policy");
        dry.tick(emergency);
        require(dry.runner.phase() == Phase::damping, "L2+B did not preempt inference");
        dry.tick(classic);
        require(dry.runner.phase() == Phase::high, "factory gait return failed");
        require(dry.robot.calls == 0 && dry.robot.writes == 0, "dry-run accessed a write path");
        require(dry.events.ordered({Event::mode_low, Event::policy_start, Event::sit_down,
                                    Event::damping, Event::policy_start, Event::damping,
                                    Event::factory_handover, Event::mode_high, Event::factory_gait}),
                "remote event order differs from Python");
    }
    {
        // 11/25 real robot: L2+A from a sitting pose must stand at once, and a second
        // L2+A while standing up must not sit it back down.
        Rig dry(false);
        dry.enter();
        dry.tick(lie);
        dry.wait(2s, lie);
        require(dry.runner.phase() == Phase::damping, "L2+A sit did not reach damping");
        dry.state.q = to_sdk(sit_pose);
        dry.tick();
        const auto folds = std::count(dry.events.seen.begin(), dry.events.seen.end(), Event::stand_fold);
        dry.tick(lie);
        dry.wait(100ms, lie);
        require(std::count(dry.events.seen.begin(), dry.events.seen.end(), Event::stand_fold) == folds, "sitting restand must skip the fold");
        dry.tick();
        dry.tick(lie);
        dry.wait(100ms, lie);
        require(dry.runner.phase() != Phase::sitting && dry.runner.phase() != Phase::damping,
                "L2+A while standing up must be ignored");
        dry.tick();
        dry.wait(4500ms);
        require(dry.runner.phase() == Phase::policy, "sitting restand did not reach policy");
    }
    {
        Rig dry(false);
        dry.enter();
        dry.tick(lie);
        dry.wait(2s, lie);
        auto flat = sit_pose;
        for (std::size_t i = 8; i < 12; ++i) flat[i] = -1.f;  // calves stretched: lying flat
        dry.state.q = to_sdk(flat);
        dry.tick();
        dry.tick(lie);
        dry.wait(100ms, lie);
        require(std::count(dry.events.seen.begin(), dry.events.seen.end(), Event::stand_fold) == 1,
                "restand from a flat pose must fold first");
    }
    {
        Rig live(true);
        live.enter();
        const int writes = live.robot.writes;
        live.wait(100ms);
        require(live.robot.writes - writes == 20, "expected twenty LowCmd writes in 100 ms");
        live.tick(emergency);
        require(live.robot.position_gain == 0 && live.robot.velocity_gain == 3,
                "emergency damping gains differ from Python");
        live.tick(classic);
        live.wait(4s);
        require(live.robot.factory && live.robot.recovery == 1 && live.robot.gaits == 1,
                "factory gait recovery and delayed gait RPC failed");
    }
    {
        Rig live(true);
        live.enter();
        live.wait(1055ms, start, false);
        require(live.runner.phase() == Phase::sitting, "stale LowState must start blind sit");
        live.wait(3s, 0, false);
        require(live.events.ordered({Event::liveness_lost, Event::sit_down, Event::damping,
                                     Event::mode_high}), "liveness return event order");
        require(live.robot.factory, "liveness loss must restore factory control");
    }
    {
        Rig live(true);
        live.enter();
        live.state.orientation = {0, 1, 0, 0};
        live.wait(540ms);
        live.wait(1s);
        require(live.events.ordered({Event::damping, Event::robot_fall, Event::mode_high,
                                     Event::robot_fall_recovery_stand}), "fall event order");
        require(live.robot.recovery == 1, "fall recovery RPC count");
    }
    {
        Rig live(true);
        live.enter();
        live.tick(0, true, true);
        live.wait(3s);
        require(live.runner.stopped(), "shutdown must complete factory return");
        require(live.events.ordered({Event::exit_sit_down, Event::sit_down, Event::damping,
                                     Event::mode_high}), "shutdown event order");
    }
    {
        Rig dry(false);
        dry.tick(start);
        for (int i = 0; i < 900; ++i) {
            dry.time += 5ms;
            const auto now = dry.time + (i % 7 == 0 ? 500us : 50us);
            dry.state.stamp = now;
            dry.state.remote.keys = 0;
            dry.runner.tick(now, dry.state, nullptr, false, dry.time);
        }
        require(dry.runner.policy_steps() == 50, "policy cadence drifted with scheduler jitter");
    }
    {
        Rig live(true);
        live.enter();
        live.policy.delayed = true;
        const auto before = live.robot.writes;
        live.wait(100ms);
        require(live.robot.writes - before == 20, "slow inference interrupted the command loop");
        live.tick(emergency);
        const auto after_damp = live.robot.writes;
        live.policy.delayed = false;
        live.wait(20ms);
        require(live.runner.phase() == Phase::damping && live.robot.writes == after_damp,
                "policy result submitted before L2+B escaped damping");
    }
    {
        Rig live(true);
        live.enter();
        live.tick(emergency);
        live.robot.acknowledge_select = false;
        const auto writes = live.robot.writes;
        live.tick(classic);
        live.wait(1s);
        require(live.robot.factory && live.runner.phase() == Phase::recovering,
                "CheckMode must confirm attachment even after a SelectMode timeout");
        require(live.robot.writes == writes, "LowCmd published after mode selection");
    }
    {
        Rig live(true);
        live.enter();
        live.tick(emergency);
        live.robot.attach_on_select = false;
        live.robot.acknowledge_select = false;
        live.tick(classic);
        const auto writes = live.robot.writes;
        live.wait(5s);
        require(live.runner.phase() == Phase::damping &&
                    live.events.ordered({Event::mode_high_retry, Event::mode_high_failed}) &&
                    !live.events.ordered({Event::mode_high}),
                "unconfirmed factory selection emitted successful mode return");
        require(live.robot.writes == writes, "old target resumed after failed mode selection");
    }
    {
        Rig dry(false, MapMode::reconstruction);
        dry.tick(start);
        require(dry.runner.phase() == Phase::high, "reconstruction armed without depth");
        Depth frame{};
        dry.depth = &frame;
        dry.enter();
        dry.wait(40ms);
        dry.depth = nullptr;
        dry.tick();
        dry.wait(2s);
        require(dry.events.ordered({Event::depth_lost, Event::sit_down, Event::damping,
                                    Event::mode_high}), "depth loss must leave reconstruction safely");
        require(dry.robot.calls == 0 && dry.robot.writes == 0, "depth loss accessed robot in dry-run");
    }
    {
        Rig live(true);
        live.enter();
        live.tick(lie);
        live.wait(2s, lie);
        live.tick();
        live.state.orientation = {0.8660254f, 0.5f, 0, 0};
        const auto before_refusal = live.robot.writes;
        live.tick(lie);
        require(live.runner.phase() == Phase::damping && live.events.seen.back() == Event::stand_refused,
                "60 degree tilt must refuse standing up");
        require(live.robot.writes == before_refusal, "tilt refusal sent a command");
        live.tick();
        live.state.orientation = {1, 0, 0, 0};
        live.state.q.fill(0);
        live.tick(lie);
        live.wait(1s);
        require(live.robot.last_target == to_sdk(sit_pose), "one-second fold must reach SIT_POSE");
        require(live.robot.position_gain == 60 && live.robot.velocity_gain == 5,
                "fold gains differ from Python");
        live.wait(3500ms);
        require(live.runner.phase() == Phase::policy, "fold did not continue through stand and gain blend");
    }
    {
        Rig live(true);
        live.tick(start, false);
        require(live.robot.calls == 0, "stale LowState armed the runner");
        live.enter();
        live.policy.next_action = NAN;
        live.wait(25ms);
        require(live.runner.phase() == Phase::damping, "nonfinite inference was used");
        require(live.robot.position_gain == 0, "nonfinite inference left position gain on");
    }

    {
        // L2+Y dog sit: no jump on entry, reach and hold the recorded pose, rise back to policy.
        Rig live(true);
        live.enter();
        auto current = default_pose;
        current[4] += .03f;
        live.state.q = to_sdk(current);
        live.tick(dog);
        require(live.runner.phase() == Phase::dog_sitting && live.events.seen.back() == Event::dog_sit,
                "L2+Y from policy must start the dog sit");
        require(distance(to_policy(live.robot.last_target), current) < .05f,
                "first dog sit command must start at the current pose");
        require(live.robot.position_gain == 60 && live.robot.velocity_gain == 5, "dog sit gains");
        live.wait(1s, dog);
        live.wait(2s);
        require(live.runner.phase() == Phase::dog_sitting, "dog sit must hold");
        require(distance(to_policy(live.robot.last_target), dog_sit_down.back().q) < 1e-5f,
                "dog sit must hold the final recorded pose");
        require(live.robot.position_gain == 60 && live.robot.velocity_gain == 5, "dog sit hold gains");
        live.state.q = to_sdk(dog_sit_down.back().q);
        live.tick(dog);
        require(live.events.seen.back() == Event::dog_rise, "second L2+Y must rise");
        require(distance(to_policy(live.robot.last_target), dog_sit_down.back().q) < .05f,
                "rise must start at the current pose");
        live.wait(2s);
        require(live.runner.phase() == Phase::dog_sitting, "rise must finish its gain blend before policy");
        live.wait(1500ms);
        require(live.runner.phase() == Phase::policy &&
                    live.events.ordered({Event::dog_sit, Event::dog_rise, Event::policy_start}),
                "rise must return to policy");
        require(live.robot.position_gain == kp && live.robot.velocity_gain == kd, "policy gains after rise");
    }
    {
        // L2+Y outside policy is ignored: factory, damping, standing up.
        Rig live(true);
        live.tick(dog);
        require(live.runner.phase() == Phase::high, "L2+Y in factory must be ignored");
        live.enter();
        live.tick(emergency);
        live.tick(dog);
        require(live.runner.phase() == Phase::damping, "L2+Y while damping must be ignored");
        live.tick();
        live.tick(start);
        live.wait(200ms);
        live.tick(dog);
        live.wait(50ms);
        require(live.runner.phase() == Phase::standing, "L2+Y while standing up must be ignored");
        require(std::count(live.events.seen.begin(), live.events.seen.end(), Event::dog_sit) == 0,
                "no dog sit outside policy");
    }
    {
        // L2+A and start+right are ignored while dog sitting. L2+B damps.
        Rig live(true);
        live.enter();
        live.tick(dog);
        live.wait(500ms);
        live.tick(lie);
        live.tick(classic);
        live.wait(50ms);
        require(live.runner.phase() == Phase::dog_sitting, "L2+A and start+right must be ignored while dog sitting");
        live.tick(emergency);
        require(live.runner.phase() == Phase::damping && live.robot.position_gain == 0 &&
                    live.robot.velocity_gain == 3, "L2+B during dog sit must damp");
    }
    {
        Rig live(true);
        live.enter();
        live.tick(dog);
        live.wait(2s);
        live.wait(60ms, 0, false);
        require(live.runner.phase() == Phase::damping && live.robot.position_gain == 0,
                "stale LowState during dog sit must damp");
    }
    {
        Rig live(true);
        live.enter();
        live.tick(dog);
        live.wait(2s);
        live.tick(0, true, true);
        live.wait(3s);
        require(live.runner.stopped() && live.robot.factory, "shutdown during dog sit must return to factory");
        require(live.events.ordered({Event::dog_sit, Event::exit_sit_down, Event::sit_down, Event::damping,
                                     Event::mode_high}), "shutdown during dog sit must lie down first");
    }
}
