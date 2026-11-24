#include "foothold/mode_worker.hpp"

#include <chrono>
#include <cstdlib>
#include <future>
#include <iostream>
#include <thread>

using namespace foothold;
using namespace std::chrono_literals;

namespace {
void require(bool condition, const char* message) {
    if (!condition) {
        std::cerr << message << '\n';
        std::exit(1);
    }
}

struct BlockingRobot final : Robot {
    std::promise<std::thread::id> entered;
    std::promise<void> proceed;
    std::future<void> released = proceed.get_future();

    RobotMode check_mode() override {
        entered.set_value(std::this_thread::get_id());
        released.wait();
        return RobotMode::factory;
    }
    void release_mode() override { std::abort(); }
    bool select_mode() override { std::abort(); }
    void recovery_stand() override { std::abort(); }
    bool select_gait(Gait) override { std::abort(); }
    void send(const Joints&, float, float) override { std::abort(); }
};
}

int main() {
    BlockingRobot robot;
    ModeWorker worker(robot);
    auto entered = robot.entered.get_future();
    worker.submit({ModeCall::check_acquire});
    require(entered.wait_for(2s) == std::future_status::ready && entered.get() != std::this_thread::get_id(),
            "mode check did not run on the worker");
    require(!worker.poll(), "poll completed while mode RPC was blocked");
    robot.proceed.set_value();
    const auto deadline = std::chrono::steady_clock::now() + 2s;
    while (std::chrono::steady_clock::now() < deadline) {
        if (const auto result = worker.poll()) {
            require(result->mode == RobotMode::factory && !worker.poll(), "invalid mode result");
            return 0;
        }
        std::this_thread::sleep_for(1ms);
    }
    require(false, "worker did not publish the mode result");
}
