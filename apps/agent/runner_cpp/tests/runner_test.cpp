#include "foothold/app_input.hpp"
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
constexpr auto dog = (1 << 0) | (1 << 9);  // R1+B, as the factory Sit Down
constexpr auto stretch = (1 << 4) | (1 << 8);  // R2+A
constexpr auto love = (1 << 4) | (1 << 11);    // R2+Y

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
        last_tau = Joints{};
        hip_gain = p;
    }
    void send_ff(const Joints& q, const Joints&, const Joints& tau, float p, float d, float hip) override {
        send(q, p, d);
        last_tau = tau;
        hip_gain = hip;
    }
    Joints last_tau{};
    float hip_gain = 0;
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
    Wanted last_want{};
    Vec3 last_command{};
    void sample(const Sample& sample) override {
        samples.push_back(sample.time);
        last_want = sample.want;
        last_command = sample.command;
    }
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
    // One control tick with the app channel, in the same order as main.cpp.
    std::vector<AppAck> app_tick(AppInput& app, std::vector<std::string> packets = {}, int keys = 0, float ly = 0) {
        time += 5ms;
        state.stamp = time;
        state.remote.keys = keys;
        state.remote.ly = ly;
        for (const auto& packet : packets) app.receive(time, packet, 40000);
        app.apply(time, state);
        const auto phase = runner.phase();
        const auto move = runner.move();
        runner.tick(time, state, depth);
        return app.settle(time, phase, move, runner.phase(), runner.move(), runner.refusal());
    }
    std::int64_t seq(std::chrono::nanoseconds back = {}) const {
        return std::chrono::duration_cast<std::chrono::nanoseconds>((time + 5ms - back).time_since_epoch()).count();
    }
    std::string key(const char* name, const char* action, const char* id, std::chrono::nanoseconds back = {}) const {
        return "{\"seq\":" + std::to_string(seq(back)) + ",\"key\":\"" + name + "\",\"action\":\"" + action +
               "\",\"request_id\":\"" + id + "\"}";
    }
    std::string stop(bool on) const {
        return "{\"seq\":" + std::to_string(seq()) + ",\"stop\":" + (on ? "1" : "0") + "}";
    }
    std::string velocity(double vx, double vy = 0, double wz = 0) const {
        return "{\"seq\":" + std::to_string(seq()) + ",\"vx\":" + std::to_string(vx) + ",\"vy\":" +
               std::to_string(vy) + ",\"wz\":" + std::to_string(wz) + "}";
    }
};

bool acked(const std::vector<AppAck>& acks, const char* result, const char* reason = nullptr) {
    return acks.size() == 1 && std::string_view(acks[0].result) == result &&
           (reason ? acks[0].reason && std::string_view(acks[0].reason) == reason : !acks[0].reason);
}
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
        // R1+B dog sit: no jump on entry, reach and hold the recorded pose, rise back to policy.
        Rig live(true);
        live.enter();
        auto current = default_pose;
        current[4] += .03f;
        live.state.q = to_sdk(current);
        live.tick(dog);
        require(live.runner.phase() == Phase::dog_sitting && live.events.seen.back() == Event::dog_sit,
                "R1+B from policy must start the dog sit");
        require(distance(to_policy(live.robot.last_target), current) < .05f,
                "first dog sit command must start at the current pose");
        require(live.robot.position_gain == 60 && live.robot.velocity_gain == 5, "dog sit gains");
        // First diagonal tap: FL and RR lift (thigh up, calf folded), FR and RL stay planted.
        live.wait(65ms, dog);
        const auto tap = to_policy(live.robot.last_target);
        require(tap[4] > current[4] + .1f && tap[7] > current[7] + .1f && tap[8] < current[8] - .2f &&
                    tap[11] < current[11] - .2f, "FL and RR must lift in the first tap");
        require(std::abs(tap[5] - current[5]) < 1e-4f && std::abs(tap[6] - current[6]) < 1e-4f &&
                    std::abs(tap[9] - current[9]) < 1e-4f, "FR and RL must stay planted in the first tap");
        live.wait(160ms);
        const auto second = to_policy(live.robot.last_target);
        require(second[5] > dog_sit_down.front().q[5] + .1f && second[6] > dog_sit_down.front().q[6] + .1f &&
                    std::abs(second[4] - dog_sit_down.front().q[4]) < 1e-4f,
                "second tap lifts FR and RL after FL and RR landed on the factory stance");
        live.wait(1s, dog);
        live.wait(2s);
        require(live.runner.phase() == Phase::dog_sitting, "dog sit must hold");
        require(distance(to_policy(live.robot.last_target), dog_sit_down.back().q) < 1e-5f,
                "dog sit must hold the final recorded pose");
        require(live.robot.position_gain == 60 && live.robot.velocity_gain == 5, "dog sit hold gains");
        live.state.q = to_sdk(dog_sit_down.back().q);
        live.tick(dog);
        require(live.events.seen.back() == Event::dog_rise, "second R1+B must rise");
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
        // Factory torque is fed forward during the dog sit, scaled and clamped.
        Rig live(true);
        live.enter();
        live.tick(dog);
        live.wait(700ms, dog);
        require(live.runner.phase() == Phase::dog_sitting, "dog sit running");
        float peak = 0;
        for (const auto x : live.robot.last_tau) peak = std::max(peak, std::abs(x));
        require(peak > .5f && peak <= 35.f, "dog sit must feed recorded torque forward within limits");
    }
    {
        // R2+A stretch: from policy only, replays the recording, returns to policy with no torque left.
        Rig live(true);
        live.enter();
        live.tick(stretch);
        require(live.runner.phase() == Phase::moving && live.events.seen.back() == Event::factory_move,
                "R2+A from policy must start the stretch");
        live.tick(emergency | stretch);
        require(live.runner.phase() == Phase::damping, "L2+B must damp during a factory move");
        live.tick();
        live.tick(start);
        live.wait(3500ms);
        require(live.runner.phase() == Phase::policy, "restand after damp");
        live.tick(stretch);
        live.wait(2s, stretch);
        require(live.runner.phase() == Phase::moving, "stretch keeps running while the key is held");
        live.wait(5s);
        require(live.runner.phase() == Phase::policy && live.events.ordered({Event::factory_move, Event::policy_start}),
                "stretch must return to policy");
        require(live.robot.position_gain == kp && live.robot.velocity_gain == kd, "policy gains after stretch");
        for (const auto x : live.robot.last_tau) require(x == 0, "no feed-forward torque after the move");
    }
    {
        // Shake hands: full recorded torque and Kp 100 on every joint (11/26 07:31 fell left, 07:43 leaned 8 to 11 deg).
        Rig live(true);
        live.enter();
        live.tick((1 << 4) | (1 << 9));
        live.wait(1500ms);
        require(live.runner.phase() == Phase::moving && live.robot.hip_gain == 100 &&
                    live.robot.position_gain == 100, "shake must hold the stance at Kp 100");
        live.wait(6s);
        require(live.runner.phase() == Phase::policy && live.robot.hip_gain == kp &&
                    live.robot.position_gain == kp, "shake must return to policy gains");
    }
    {
        // A sideways tip during a move damps and hands over to factory recovery.
        Rig live(true);
        live.enter();
        live.tick(love);
        live.wait(1s);
        live.state.orientation = {0.8660254f, 0.5f, 0, 0};
        live.wait(400ms);
        require(live.events.ordered({Event::factory_move, Event::move_fall, Event::robot_fall}),
                "tip during a factory move must report a fall");
        require(live.runner.phase() != Phase::moving && live.robot.position_gain == 0, "fall must damp");
    }
    {
        // R1+B outside policy is ignored: factory, damping, standing up.
        Rig live(true);
        live.tick(dog);
        require(live.runner.phase() == Phase::high, "R1+B in factory must be ignored");
        live.enter();
        live.tick(emergency);
        live.tick(dog);
        require(live.runner.phase() == Phase::damping, "R1+B while damping must be ignored");
        live.tick();
        live.tick(start);
        live.wait(200ms);
        live.tick(dog);
        live.wait(50ms);
        require(live.runner.phase() == Phase::standing, "R1+B while standing up must be ignored");
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

    {
        // start+right from policy hands over only after the robot has been stopped for 1 s.
        Rig live(true);
        live.enter();
        live.tick(classic);
        require(live.runner.phase() == Phase::policy && live.runner.refusal() &&
                    std::string_view(live.runner.refusal()) == "not_stopped" &&
                    live.events.seen.back() == Event::handover_refused,
                "handover right after entering policy must be refused");
        live.wait(1500ms, classic);
        require(live.runner.phase() == Phase::policy, "a refused press held on must not hand over later");
        live.tick();
        // Walking (stick forward): command is not zero, so still refused even after a long wait.
        live.state.remote.ly = .5f;
        for (int i = 0; i < 300; ++i) { live.time += 5ms; live.state.stamp = live.time; live.runner.tick(live.time, live.state); }
        live.state.remote.keys = classic;
        live.time += 5ms; live.state.stamp = live.time; live.runner.tick(live.time, live.state);
        require(live.runner.phase() == Phase::policy, "handover while walking must be refused");
        live.state.remote.ly = 0;
        live.tick();
        // Release the stick: the command slews to zero (~0.3 s), then must stay still for 1 s.
        live.wait(1100ms);
        live.tick(classic);
        require(live.runner.phase() == Phase::policy, "handover before 1 s of stillness must be refused");
        live.tick();
        live.wait(500ms);
        live.tick(classic);
        require(live.runner.phase() == Phase::sitting && !live.runner.refusal(),
                "handover after 1 s stopped must lie down and return to factory");
        live.wait(4s);
        require(live.robot.factory, "handover must reach factory mode");
    }
    {
        // App START+RIGHT (ClassicWalk): same stillness gate, ack IGNORED not_stopped, then STARTED.
        Rig live(true);
        AppInput app(live.events);
        live.enter();
        require(acked(live.app_tick(app, {live.key("START+RIGHT", "ClassicWalk", "c1")}), "IGNORED", "not_stopped") &&
                    live.runner.phase() == Phase::policy,
                "app handover right after policy must be ignored with not_stopped");
        for (int i = 0; i < 100; ++i) live.app_tick(app, i % 4 == 0 ? std::vector<std::string>{live.velocity(.6)}
                                                                     : std::vector<std::string>{});
        require(acked(live.app_tick(app, {live.key("START+RIGHT", "ClassicWalk", "c2")}), "IGNORED", "not_stopped"),
                "app handover while the app drives must be ignored");
        for (int i = 0; i < 400; ++i) live.app_tick(app);
        require(acked(live.app_tick(app, {live.key("START+LEFT", "FreeWalk", "f")}), "STARTED") &&
                    live.runner.phase() == Phase::sitting,
                "app handover after the deadman stop and 1 s still must start");
    }

    // App input (APP-MOVES.md): the same handling as the physical remote.
    {
        // App key outside policy is ignored by the runner's own guard; from policy it starts the move.
        Rig live(true);
        AppInput app(live.events);
        require(acked(live.app_tick(app, {live.key("R1+B", "Sit", "a")}), "IGNORED", "phase") &&
                    live.runner.phase() == Phase::high,
                "app R1+B in factory must be ignored");
        live.tick(start);
        live.wait(3500ms);
        require(live.runner.phase() == Phase::policy, "policy");
        const auto acks = live.app_tick(app, {live.key("R1+B", "Sit", "b")});
        require(acked(acks, "STARTED") && acks[0].request_id == "b" && std::string_view(acks[0].phase) == "dog_sitting",
                "app R1+B from policy must start the dog sit and ack STARTED");
        require(live.events.seen.back() == Event::app_key || live.events.ordered({Event::dog_sit, Event::app_key}),
                "app key must be traced");
        // The key is pressed for one tick only: a repeat during the move is dropped like a remote press.
        require(acked(live.app_tick(app, {live.key("R1+B", "RiseSit", "c")}), "IGNORED", "phase"),
                "app R1+B during the sit-down motion must be ignored");
        for (int i = 0; i < 400; ++i) live.app_tick(app);
        require(acked(live.app_tick(app, {live.key("R1+B", "RiseSit", "d")}), "STARTED") &&
                    live.runner.move() == Move::dog_rise,
                "app R1+B while holding the dog sit must rise");
    }
    {
        // App velocity reaches the policy command through the same shaping and slew as the stick,
        // and expires to zero 0.3 s after the last packet.
        Rig live(true);
        AppInput app(live.events);
        live.enter();
        for (int i = 0; i < 300; ++i) {
            const auto acks = live.app_tick(app, i % 4 == 0 ? std::vector<std::string>{live.velocity(.6)}
                                                            : std::vector<std::string>{});
            if (i % 4 == 0) require(acked(acks, "ACCEPTED") && std::string_view(acks[0].phase) == "policy",
                                    "velocity packet must be accepted in policy");
        }
        require(live.events.last_want[0] == .6 && std::abs(live.events.last_command[0] - .6f) < 1e-4f,
                "app velocity must reach the policy command");
        for (int i = 0; i < 56; ++i) live.app_tick(app);  // 0.295 s after the last packet (sent 15 ms before)
        require(live.events.last_want[0] == .6, "app velocity must hold inside the deadman window");
        for (int i = 0; i < 6; ++i) live.app_tick(app);
        require(live.events.last_want[0] == 0, "app velocity must expire to zero after 0.3 s");
        for (int i = 0; i < 200; ++i) live.app_tick(app);
        require(live.events.last_command[0] == 0, "policy command must slew to zero after expiry");
        // Out-of-range values are clamped to what the stick can ask for.
        for (int i = 0; i < 10; ++i) live.app_tick(app, {live.velocity(1.9, -1.0, 2.5)});
        require(live.events.last_want == Wanted{1.5, -.8, 1.5}, "app velocity must be clamped to the stick range");
    }
    {
        // Physical remote wins: a stick or any key drops app velocity and keys (ack IGNORED remote).
        Rig live(true);
        AppInput app(live.events);
        live.enter();
        for (int i = 0; i < 20; ++i) live.app_tick(app, {live.velocity(.6)});
        const auto acks = live.app_tick(app, {live.velocity(.6)}, 0, .5f);
        require(acked(acks, "IGNORED", "remote") && acks[0].remote, "app velocity under a physical stick must be ignored");
        for (int i = 0; i < 4; ++i) live.app_tick(app, {}, 0, .5f);
        require(live.events.last_want[0] == .375, "physical stick must drive the policy, not the app");
        live.app_tick(app);
        live.app_tick(app);
        live.app_tick(app);
        live.app_tick(app);
        require(live.events.last_want[0] == 0, "app velocity cleared by the physical stick must not come back");
        constexpr int r2 = 1 << 4;
        require(acked(live.app_tick(app, {live.key("R2+A", "Stretch", "s")}, r2), "IGNORED", "remote") &&
                    live.runner.phase() == Phase::policy,
                "app key while a physical key is held must be ignored");
        require(acked(live.app_tick(app, {live.key("R2+A", "Stretch", "s2")}, 0, .5f), "IGNORED", "remote") &&
                    live.runner.phase() == Phase::policy,
                "app key while the physical stick is deflected must be ignored");
        // The app damp is the exception: it always passes.
        require(acked(live.app_tick(app, {live.key("L2+B", "Damp", "d")}, 0, .5f), "STARTED") &&
                    live.runner.phase() == Phase::damping,
                "app L2+B must damp even under a physical stick");
    }
    {
        // App STOP beats the physical stick (11/28): want 0 under a deflected stick, the policy keeps
        // standing (no damping), and it holds until the app release, not until the stick is released.
        Rig live(true);
        AppInput app(live.events);
        live.enter();
        for (int i = 0; i < 20; ++i) live.app_tick(app, {}, 0, .5f);
        require(live.events.last_want[0] == .375, "physical stick must drive before the app stop");
        const auto acks = live.app_tick(app, {live.stop(true)}, 0, .5f);
        require(acked(acks, "ACCEPTED") && acks[0].remote, "app stop under a physical stick must be accepted");
        for (int i = 0; i < 400; ++i) live.app_tick(app, {}, 0, .5f);
        require(live.events.last_want[0] == 0 && live.events.last_command[0] == 0 && live.runner.phase() == Phase::policy,
                "app stop must hold zero under a deflected stick and keep the policy standing");
        for (int i = 0; i < 20; ++i) live.app_tick(app, {}, 0, 0);
        for (int i = 0; i < 20; ++i) live.app_tick(app, {}, 0, .5f);
        require(live.events.last_want[0] == 0, "releasing and moving the stick again must not lift the app stop");
        for (int i = 0; i < 20; ++i) live.app_tick(app, {live.velocity(.6)});
        require(live.events.last_want[0] == 0, "app velocity must not lift the app stop");
        require(acked(live.app_tick(app, {live.stop(false)}, 0, .5f), "ACCEPTED"), "app release must be accepted");
        for (int i = 0; i < 20; ++i) live.app_tick(app, {}, 0, .5f);
        require(live.events.last_want[0] == .375, "after the app release the physical stick drives again");
        // Remote L2+B still damps while the app stop holds.
        live.app_tick(app, {live.stop(true)});
        live.app_tick(app, {}, emergency);
        require(live.runner.phase() == Phase::damping, "physical L2+B must still damp during an app stop");
    }
    {
        // Physical L2+B wins over any app key in the same tick; an app damp beats an app move in one batch.
        Rig live(true);
        AppInput app(live.events);
        live.enter();
        live.app_tick(app, {live.key("R2+A", "Stretch", "s")}, emergency);
        require(live.runner.phase() == Phase::damping, "physical L2+B must damp over an app key");
        Rig other(true);
        AppInput second(other.events);
        other.enter();
        const auto acks = other.app_tick(second, {other.key("R2+A", "Stretch", "s"), other.key("L2+B", "Damp", "d", -1ns)});
        require(other.runner.phase() == Phase::damping && acks.size() == 2 &&
                    std::string_view(acks[0].reason) == "busy" && std::string_view(acks[1].result) == "STARTED",
                "app damp must win over another app key in the same tick");
    }
    {
        // Malformed, stale, replayed and future packets are dropped without an ack and change nothing.
        Rig live(true);
        AppInput app(live.events);
        live.enter();
        const auto fresh = live.key("R2+A", "Stretch", "x");
        std::vector<std::string> bad{
            live.key("R2+A", "Stretch", "old", 600ms), live.key("R2+A", "Stretch", "future", -50ms),
            live.key("R2+A", "Sit", "wrong-action"), live.key("L2+X", "Damp", "bad-key"),
            "{\"seq\":1,\"vx\":0.5}", "not json", "{\"seq\":-5,\"vx\":0,\"vy\":0,\"wz\":0}",
            "{\"seq\":" + std::to_string(live.seq()) + ",\"vx\":NaN,\"vy\":0,\"wz\":0}",
            std::string(600, ' '),
        };
        require(live.app_tick(app, bad).empty() && live.runner.phase() == Phase::policy && app.dropped() == bad.size(),
                "bad packets must be dropped");
        require(std::count(live.events.seen.begin(), live.events.seen.end(), Event::app_drop) == 1,
                "drop events are rate limited");
        const auto acks = live.app_tick(app, {fresh, fresh});
        require(acks.size() == 1 && acked(acks, "STARTED") && app.dropped() == bad.size() + 1,
                "fresh packet must start once and its replay must be dropped");
    }
}
