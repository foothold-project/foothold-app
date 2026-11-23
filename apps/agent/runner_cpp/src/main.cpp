#include "foothold/depth_receiver.hpp"
#include "foothold/ort_policy.hpp"
#include "foothold/policy_worker.hpp"
#include "foothold/trace.hpp"
#ifdef FOOTHOLD_UNITREE
#include "foothold/unitree_robot.hpp"
#endif

#include <cerrno>
#include <cmath>
#include <csignal>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <iostream>
#include <limits>
#include <optional>
#include <stdexcept>
#include <string_view>
#include <thread>
#include <sched.h>
#include <sys/mman.h>

using namespace foothold;
using namespace std::chrono_literals;

namespace {
volatile std::sig_atomic_t interrupted = 0;
void request_stop(int) { interrupted = 1; }

struct Config {
    std::filesystem::path bundle, trace, depth_socket;
    std::string nic, factory_mode = "mcf";
    Options runner;
    bool benchmark = false, armed = false, lock_memory = false;
    int priority = 0, cpu_first = 4, cpu_last = 7;
    double seconds = 0, status = 1;
};

const char* usage = "foothold_start --folder BUNDLE [--nic NIC | --benchmark] "
    "[--mode off|reconstruction|auto] [--depth-socket PATH] [--pose-height M] [--pose-roll RAD] [--seconds N] [--status N] [--trace-dir DIR] "
    "[--cpu-range FIRST-LAST] [--rt-priority N] [--mlock] [--fwd-max N] "
    "[--stand-only] [--live --armed-by-remote]";

double number(std::string_view value) {
    std::size_t end = 0;
    const double result = std::stod(std::string(value), &end);
    if (end != value.size() || !std::isfinite(result))
        throw std::invalid_argument("expected a finite number");
    return result;
}

int integer(std::string_view value, int max) {
    const double converted = number(value);
    if (converted < 0 || converted > max || std::trunc(converted) != converted)
        throw std::invalid_argument("integer out of bounds");
    return static_cast<int>(converted);
}

Config parse(int argc, char** argv) {
    Config config;
    bool explicit_mode = false, explicit_pose = false;
    for (int i = 1; i < argc; ++i) {
        const std::string_view option(argv[i]);
        auto value = [&]() -> std::string_view {
            if (++i == argc) throw std::invalid_argument("missing value for " + std::string(option));
            return argv[i];
        };
        if (option == "--folder") config.bundle = value();
        else if (option == "--trace-dir") config.trace = value();
        else if (option == "--depth-socket") config.depth_socket = value();
        else if (option == "--nic") config.nic = value();
        else if (option == "--sport-mode") config.factory_mode = value();
        else if (option == "--mode") {
            config.runner.map = parse_map_mode(value());
            explicit_mode = true;
        } else if (option == "--pose-height" || option == "--pose-roll") {
            const auto index = option == "--pose-height" ? 0 : 1;
            const auto pose = number(value());
            if (std::abs(pose) > std::numeric_limits<float>::max())
                throw std::invalid_argument("pose exceeds float32 range");
            config.runner.pose[index] = static_cast<float>(pose);
            explicit_pose = true;
        }
        else if (option == "--seconds") config.seconds = number(value());
        else if (option == "--status") config.status = number(value());
        else if (option == "--fwd-max") config.runner.fwd_max = number(value());
        else if (option == "--rt-priority") config.priority = integer(value(), 99);
        else if (option == "--cpu-range") {
            const auto range = value();
            const auto dash = range.find('-');
            if (dash == range.npos) throw std::invalid_argument("expected CPU range FIRST-LAST");
            config.cpu_first = integer(range.substr(0, dash), CPU_SETSIZE - 1);
            config.cpu_last = integer(range.substr(dash + 1), CPU_SETSIZE - 1);
        } else if (option == "--benchmark") config.benchmark = true;
        else if (option == "--armed-by-remote") config.armed = true;
        else if (option == "--stand-only") config.runner.stand_only = true;
        else if (option == "--mlock") config.lock_memory = true;
        else if (option == "--live") config.runner.live = true;
        else throw std::invalid_argument("unknown argument: " + std::string(option));
    }
    if (config.bundle.empty() || (config.nic.empty() && !config.benchmark) ||
        config.cpu_first > config.cpu_last || config.seconds < 0 || config.seconds > 7 * 86400 ||
        config.status < 0 || config.status > 86400 || (config.status > 0 && config.status < 0.05))
        throw std::invalid_argument(usage);
    const bool mapmask = std::filesystem::exists(config.bundle / "start_onnx.json");
    if (!explicit_mode && mapmask) config.runner.map = MapMode::automatic;
    if (config.runner.live && (mapmask || config.runner.map == MapMode::automatic))
        throw std::invalid_argument("experimental map-mask is restricted to dry-run");
    if (explicit_pose && !mapmask) throw std::invalid_argument("pose requires the map-mask contract");
    if (config.runner.map == MapMode::gt)
        throw std::invalid_argument("gt is vector-replay only");
    if (config.runner.map == MapMode::reconstruction && !config.benchmark && config.depth_socket.empty())
        throw std::invalid_argument("reconstruction requires --depth-socket");
    if (config.runner.map == MapMode::off && !config.depth_socket.empty())
        throw std::invalid_argument("--depth-socket requires reconstruction or auto mode");
    if (config.benchmark && config.runner.stand_only)
        throw std::invalid_argument("benchmark requires policy inference");
    if (config.runner.live) {
        const auto* enabled = std::getenv("FH_GO2_DIRECT_ENABLED");
        const auto* nic = std::getenv("FH_GO2_DIRECT_NIC");
        if (!config.armed || config.benchmark || !enabled || std::string_view(enabled) != "1" ||
            !nic || config.nic != nic)
            throw std::invalid_argument("live requires arming by remote and matching direct-control environment");
        if (config.priority < 2 || !config.lock_memory)
            throw std::invalid_argument("live requires --rt-priority at least 2 and --mlock");
        if (std::filesystem::exists("/tmp/foothold-start-active"))
            throw std::runtime_error("START active flag already exists");
    } else if (config.armed) {
        throw std::invalid_argument("--armed-by-remote requires --live");
    }
    return config;
}

class DryRobot final : public Robot {
public:
    RobotMode check_mode() override { return forbidden(); }
    void release_mode() override { forbidden(); }
    bool select_mode() override { forbidden(); }
    void recovery_stand() override { forbidden(); }
    bool select_gait(Gait) override { forbidden(); }
    void send(const Joints&, float, float) override { forbidden(); }
private:
    [[noreturn]] static RobotMode forbidden() { throw std::logic_error("dry-run called a robot write path"); }
};

void pin(const Config& config) {
    cpu_set_t available, desired;
    CPU_ZERO(&available);
    CPU_ZERO(&desired);
    if (sched_getaffinity(0, sizeof(available), &available) == -1)
        throw std::runtime_error("cannot read CPU affinity");
    std::string selected;
    for (int cpu = config.cpu_first; cpu <= config.cpu_last; ++cpu) {
        if (!CPU_ISSET(cpu, &available)) continue;
        CPU_SET(cpu, &desired);
        if (!selected.empty()) selected += ',';
        selected += std::to_string(cpu);
    }
    if (selected.empty()) throw std::runtime_error("no requested CPUs available in current affinity");
    if (sched_setaffinity(0, sizeof(desired), &desired) == -1)
        throw std::runtime_error("cannot set CPU affinity");
    std::cout << "{\"runner_cpus\":[" << selected << "]}\n";
}

bool realtime(const Config& config) {
    bool locked = false, fifo = false;
    if (config.lock_memory) {
        locked = mlockall(MCL_CURRENT | MCL_FUTURE) == 0;
        if (!locked) std::cerr << "mlockall: " << std::strerror(errno) << '\n';
    }
    if (config.priority) {
        sched_param params{};
        params.sched_priority = config.priority;
        fifo = sched_setscheduler(0, SCHED_FIFO, &params) == 0;
        if (!fifo) std::cerr << "SCHED_FIFO: " << std::strerror(errno) << '\n';
    }
    std::cout << "{\"mlock\":" << (locked ? "true" : "false")
              << ",\"sched_fifo\":" << (fifo ? "true" : "false") << "}\n";
    return locked && fifo;
}

Tick::duration interval(double seconds) {
    return std::chrono::duration_cast<Tick::duration>(std::chrono::duration<double>(seconds));
}

template<class Read, class Writes>
int run(const Config& config, Robot& robot, PolicyExecutor& policy, Trace& trace, DepthReceiver* depth_receiver, Read read, Writes writes) {
    Runner runner(robot, policy, trace, config.runner);
    PeriodStats policy_period, control_period;
    std::optional<Tick> previous_tick, previous_policy;
    std::uint64_t resyncs = 0;
    std::exception_ptr control_failure;
    bool saw_state = false, benchmark_armed = false, benchmark_in_policy = false;
    Depth synthetic_depth;
    synthetic_depth.fill(1.f);
    const auto* replay_depth = config.runner.map == MapMode::reconstruction ? &synthetic_depth : nullptr;
    auto next = std::chrono::steady_clock::now();
    const auto begin = next;
    const auto end = config.seconds ? begin + interval(config.seconds) : Tick::max();
    const auto status_interval = interval(config.status);
    auto next_status = config.status ? begin + status_interval : Tick::max();

    while (!runner.stopped()) {
        std::this_thread::sleep_until(next);
        const auto now = std::chrono::steady_clock::now();
        auto state = read(now);
        saw_state = saw_state || state.stamp != Tick{};
        if (!saw_state && now - begin >= 10s)
            throw std::runtime_error("no LowState received in ten seconds");
        const auto* depth = depth_receiver ? depth_receiver->latest(now) : replay_depth;
        const bool shutdown = interrupted || now >= end || control_failure;
        if (config.benchmark) {
            // Only simulate the local arming input. Dry-run never opens write clients.
            state.remote = {};
            if (!benchmark_armed && state.stamp != Tick{} && now - state.stamp <= 50ms && !shutdown &&
                (config.runner.map != MapMode::reconstruction || depth)) {
                state.remote.keys = (1 << 12) | (1 << 2);
                benchmark_armed = true;
            }
        }
        if (previous_tick) control_period.mark(now - *previous_tick);
        previous_tick = now;
        const auto steps = runner.policy_steps();
        try {
            runner.tick(now, state, depth, shutdown, next);
        } catch (...) {
            if (!config.runner.live || control_failure) throw;
            // If the SDK throws after takeover, give the state machine the
            // same opportunity to sit and restore factory mode as SIGTERM.
            control_failure = std::current_exception();
        }
        if (runner.policy_steps() != steps) {
            if (previous_policy) policy_period.mark(now - *previous_policy);
            previous_policy = now;
        }
        if (runner.phase() == Phase::policy) {
            benchmark_in_policy = true;
        } else {
            previous_policy.reset();
            if (config.benchmark && !shutdown && benchmark_in_policy)
                throw std::runtime_error("benchmark left policy before the requested duration");
        }
        if (config.benchmark && !shutdown && !benchmark_in_policy && now - begin >= 10s)
            throw std::runtime_error("benchmark failed to arm policy within ten seconds");

        next += 5ms;
        const auto after = std::chrono::steady_clock::now();
        if (after >= next) {
            const auto skipped = (after - next) / 5ms + 1;
            next += skipped * 5ms;
            ++resyncs;
        }
        if (now >= next_status) {
            trace.status(now, runner.phase(), runner.commands(), writes(), policy_period, control_period, resyncs);
            next_status = now + status_interval;
        }
    }

    trace.status(std::chrono::steady_clock::now(), runner.phase(), runner.commands(), writes(),
                 policy_period, control_period, resyncs);
    trace.close();
    if (control_failure) std::rethrow_exception(control_failure);
    if (runner.phase() != Phase::high || (config.benchmark && policy_period.count == 0)) return 1;
    return trace.failed() || trace.dropped() ? 1 : 0;
}
}

int main(int argc, char** argv) {
    try {
        if (argc == 2 && std::string_view(argv[1]) == "--help") {
            std::cout << usage << '\n';
            return 0;
        }
        const auto config = parse(argc, argv);
        std::signal(SIGTERM, request_stop);
        std::signal(SIGINT, request_stop);
        Trace trace(config.trace, config.runner.live);
        std::optional<DepthReceiver> depth;
        if (!config.depth_socket.empty()) depth.emplace(config.depth_socket);
        auto* receiver = depth ? &*depth : nullptr;
        pin(config);
        OrtPolicy policy(config.bundle, config.runner.map);
        if (config.runner.live && policy.mapmask_contract())
            throw std::invalid_argument("experimental map-mask is restricted to dry-run");
        Inputs warm_input{};
        Outputs warm_output{};
        warm_input.first_after_reset = true;
        warm_input.depth_tick = true;
        warm_input.pose = config.runner.pose;
        policy.infer(warm_input, warm_output);
        PolicyWorker worker(policy, config.priority > 1 ? config.priority - 1 : config.priority);
        std::cout << "{\"policy_sched_fifo\":" << (worker.realtime() ? "true" : "false") << "}\n";
        if (config.runner.live && !worker.realtime())
            throw std::runtime_error("live inference real-time setup failed");
        if (!config.nic.empty()) {
#ifdef FOOTHOLD_UNITREE
            UnitreeRobot robot(config.nic, config.runner.live, config.factory_mode);
            if (!realtime(config) && config.runner.live)
                throw std::runtime_error("live real-time setup failed");
            return run(config, robot, worker, trace, receiver, [&](Tick) { return robot.read(); },
                       [&] { return robot.writes(); });
#else
            throw std::invalid_argument("binary was built without the Unitree SDK");
#endif
        }
        realtime(config);
        DryRobot robot;
        return run(config, robot, worker, trace, receiver,
                   [](Tick now) {
                       LowState state;
                       state.stamp = now;
                       state.q = to_sdk(default_pose);
                       return state;
                   }, [] { return 0; });
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
