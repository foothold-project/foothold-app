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
    void send(const Joints&, float p, float d) override {
        require(!factory, "LowCmd and factory control overlapped");
        ++writes;
        position_gain = p;
        velocity_gain = d;
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
    FakePolicy policy;
    Events events;
    Runner runner;
    LowState state;
    Tick time{};
    const Depth* depth = nullptr;

    explicit Rig(bool live, MapMode mode = MapMode::off) : runner(robot, policy, events, {live, mode}) {
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
        dry.wait(3500ms);
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
        live.tick(start, false);
        require(live.robot.calls == 0, "stale LowState armed the runner");
        live.enter();
        live.policy.next_action = NAN;
        live.wait(25ms);
        require(live.runner.phase() == Phase::damping, "nonfinite inference was used");
        require(live.robot.position_gain == 0, "nonfinite inference left position gain on");
    }
}
