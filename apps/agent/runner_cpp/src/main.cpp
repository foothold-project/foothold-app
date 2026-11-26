#include "foothold/app_socket.hpp"
#include "foothold/depth_receiver.hpp"
#include "foothold/depth_sampler.hpp"
#include "foothold/ort_policy.hpp"
#include "foothold/policy_worker.hpp"
#include "foothold/mode_worker.hpp"
#include "foothold/trace.hpp"
#include "foothold/thread_schedule.hpp"
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
    std::filesystem::path bundle, trace, depth_socket, debug_est, status_log;
    std::string nic, factory_mode = "mcf";
    Options runner;
    bool benchmark = false, armed = false, lock_memory = false;
    int priority = 0, app_port = 0;
    CpuRange cpus{4, 7};
    std::optional<CpuRange> control_cpus, sensing_cpus, io_cpus;
    std::optional<int> sensing_priority;
    double seconds = 0, status = 1;
};

const char* usage = "foothold_start --folder BUNDLE [--nic NIC | --benchmark] "
    "[--mode off|reconstruction] [--debug-est DIR] [--depth-socket PATH] [--seconds N] [--status N] [--status-log FILE] [--trace-dir DIR] "
    "[--cpu-range FIRST-LAST | --control-cpus CPUSET --sensing-cpus CPUSET --io-cpus CPUSET] "
    "[--rt-priority N] [--sensing-rt-priority N] [--mlock] [--fwd-max N] "
    "[--stand-only] [--stop-mode sit] [--app-port PORT] [--live --armed-by-remote]";

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

CpuRange cpu_range(std::string_view value) {
    const auto dash = value.find('-');
    const int first = integer(value.substr(0, dash), CPU_SETSIZE - 1);
    const int last = dash == value.npos ? first : integer(value.substr(dash + 1), CPU_SETSIZE - 1);
    if (first > last) throw std::invalid_argument("reversed CPU range");
    return {first, last};
}

Config parse(int argc, char** argv) {
    Config config;
    bool legacy_cpus = false;
    for (int i = 1; i < argc; ++i) {
        const std::string_view option(argv[i]);
        auto value = [&]() -> std::string_view {
            if (++i == argc) throw std::invalid_argument("missing value for " + std::string(option));
            return argv[i];
        };
        if (option == "--folder") config.bundle = value();
        else if (option == "--debug-est") config.debug_est = value();
        else if (option == "--trace-dir") config.trace = value();
        else if (option == "--depth-socket") config.depth_socket = value();
        else if (option == "--nic") config.nic = value();
        else if (option == "--stop-mode") {
            if (value() != "sit") throw std::invalid_argument("C++ runner supports only --stop-mode sit");
        } else if (option == "--sport-mode") config.factory_mode = value();
        else if (option == "--mode") config.runner.map = parse_map_mode(value());
        else if (option == "--seconds") config.seconds = number(value());
        else if (option == "--status-log") config.status_log = value();
        else if (option == "--status") config.status = number(value());
        else if (option == "--fwd-max") config.runner.fwd_max = number(value());
        else if (option == "--rt-priority") config.priority = integer(value(), 99);
        else if (option == "--sensing-rt-priority") config.sensing_priority = integer(value(), 99);
        else if (option == "--control-cpus") config.control_cpus = cpu_range(value());
        else if (option == "--sensing-cpus") config.sensing_cpus = cpu_range(value());
        else if (option == "--io-cpus") config.io_cpus = cpu_range(value());
        else if (option == "--cpu-range") {
            config.cpus = cpu_range(value());
            legacy_cpus = true;
        } else if (option == "--benchmark") config.benchmark = true;
        else if (option == "--armed-by-remote") config.armed = true;
        else if (option == "--stand-only") config.runner.stand_only = true;
        else if (option == "--app-port") config.app_port = integer(value(), 65535);
        else if (option == "--mlock") config.lock_memory = true;
        else if (option == "--live") config.runner.live = true;
        else throw std::invalid_argument("unknown argument: " + std::string(option));
    }
    if (config.bundle.empty() || (config.nic.empty() && !config.benchmark) ||
        config.seconds < 0 || config.seconds > 7 * 86400 ||
        config.status < 0 || config.status > 86400 || (config.status > 0 && config.status < 0.05))
        throw std::invalid_argument(usage);
    const bool split = config.control_cpus || config.sensing_cpus || config.io_cpus;
    if (split && (legacy_cpus || !config.control_cpus || !config.sensing_cpus || !config.io_cpus))
        throw std::invalid_argument("specify all three CPU partitions together, without --cpu-range");
    if (config.sensing_priority && (!split || *config.sensing_priority >= config.priority ||
                                    (config.runner.live && *config.sensing_priority == 0)))
        throw std::invalid_argument("sensing priority requires CPU partitions and must be below control");
    if (config.app_port != 0 && config.app_port < 1024)
        throw std::invalid_argument("--app-port must be 0 (off) or 1024-65535");
    if (config.runner.map == MapMode::gt)
        throw std::invalid_argument("gt is vector-replay only");
    if (config.runner.map == MapMode::reconstruction && !config.benchmark && config.depth_socket.empty())
        throw std::invalid_argument("reconstruction requires --depth-socket");
    if (config.runner.map == MapMode::off && !config.depth_socket.empty())
        throw std::invalid_argument("--depth-socket requires reconstruction");
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

struct Layout {
    cpu_set_t control, sensing, io;
    bool split;
};

Layout layout_for(const Config& config) {
    const auto allowed = allowed_cpus();
    if (!config.control_cpus) {
        const auto runner = select_cpus(allowed, config.cpus, false);
        return {runner, runner, allowed, false};
    }
    const Layout layout{select_cpus(allowed, *config.control_cpus, true),
                        select_cpus(allowed, *config.sensing_cpus, true),
                        select_cpus(allowed, *config.io_cpus, true), true};
    if (overlaps(layout.control, layout.sensing) || overlaps(layout.control, layout.io) ||
        overlaps(layout.sensing, layout.io))
        throw std::invalid_argument("CPU partitions must not overlap");
    return layout;
}

void report_runner_cpus(const cpu_set_t& cpus) {
    std::cout << "{\"runner_cpus\":[";
    bool first = true;
    for (int cpu = 0; cpu < CPU_SETSIZE; ++cpu) {
        if (!CPU_ISSET(cpu, &cpus)) continue;
        if (!first) std::cout << ',';
        first = false;
        std::cout << cpu;
    }
    std::cout << "]}\n";
}

bool realtime(const Config& config) {
    bool locked = false, fifo = false;
    if (config.lock_memory) {
        locked = mlockall(MCL_CURRENT | MCL_FUTURE) == 0;
        if (!locked) std::cerr << "mlockall: " << std::strerror(errno) << '\n';
    }
    if (config.priority) {
        fifo = set_fifo(config.priority);
        if (!fifo) std::cerr << "unable to apply control SCHED_FIFO\n";
    }
    std::cout << "{\"mlock\":" << (locked ? "true" : "false")
              << ",\"sched_fifo\":" << (fifo ? "true" : "false") << "}\n";
    return locked && fifo;
}

Tick::duration interval(double seconds) {
    return std::chrono::duration_cast<Tick::duration>(std::chrono::duration<double>(seconds));
}

template<class DepthRead, class Read, class Writes>
int run(const Config& config, Robot& robot, PolicyExecutor& policy, Trace& trace,
        DepthRead read_depth, Read read, Writes writes, ModeExecutor* modes = nullptr) {
    Runner runner(robot, policy, trace, config.runner, modes);
    // App input (APP-MOVES.md): off unless --app-port. Bound before the first tick so a bind
    // failure stops the runner while it is still in factory mode.
    std::optional<AppSocket> app;
    AppInput app_input(trace, config.runner.fwd_max);
    if (config.app_port) {
        app.emplace(static_cast<std::uint16_t>(config.app_port));
        std::cout << "{\"app_port\":" << app->port() << "}\n";
    }
    PeriodStats policy_period, control_period;
    std::optional<Tick> previous_tick, previous_policy;
    std::uint64_t resyncs = 0;
    std::exception_ptr control_failure;
    LowState state;
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
        state = read(now);
        if (!saw_state && state.stamp != Tick{}) {
            saw_state = true;
            trace.event(now, Event::runner_ready, {});
        }
        if (!saw_state && now - begin >= 10s)
            throw std::runtime_error("no LowState received in ten seconds");
        const auto* depth = config.depth_socket.empty() ? replay_depth : read_depth(now);
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
        if (app) {
            app->poll(now, app_input);
            app_input.apply(now, state);
        }
        if (previous_tick) control_period.mark(now - *previous_tick);
        previous_tick = now;
        const auto steps = runner.policy_steps();
        const auto phase_before = runner.phase();
        const auto move_before = runner.move();
        try {
            runner.tick(now, state, depth, shutdown, next);
        } catch (...) {
            if (!config.runner.live || control_failure) throw;
            // If the SDK throws after takeover, give the state machine the
            // same opportunity to sit and restore factory mode as SIGTERM.
            control_failure = std::current_exception();
        }
        if (app) app->reply(app_input.settle(now, phase_before, move_before, runner.phase(), runner.move()));
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
            trace.status(now, runner.phase(), runner.commands(), writes(), policy_period, control_period, resyncs, state.battery);
            next_status = now + status_interval;
        }
    }

    trace.status(std::chrono::steady_clock::now(), runner.phase(), runner.commands(), writes(),
                 policy_period, control_period, resyncs, state.battery);
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
        const auto layout = layout_for(config);
        if (layout.split) {
            normal_thread();
            pin_thread(layout.io);
        }
        std::signal(SIGTERM, request_stop);
        std::signal(SIGINT, request_stop);
        Trace trace(config.trace, config.runner.live, config.status_log);
        pin_thread(layout.sensing);
        std::optional<DepthReceiver> depth;
        std::optional<DepthSampler> sampler;
        if (!config.depth_socket.empty()) {
            if (layout.split) sampler.emplace(config.depth_socket);
            else depth.emplace(config.depth_socket);
        }
        const auto read_depth = [&](Tick now) {
            return sampler ? sampler->latest(now) : depth->latest(now);
        };
        OrtPolicy policy(config.bundle, config.runner.map, config.debug_est);
        Inputs warm_input{};
        Outputs warm_output{};
        warm_input.first_after_reset = true;
        warm_input.depth_tick = true;
        policy.infer(warm_input, warm_output);
        const auto sensing_priority = config.sensing_priority.value_or(
            config.priority > 1 ? config.priority - 1 : config.priority);
        PolicyWorker worker(policy, sensing_priority);
        std::cout << "{\"policy_sched_fifo\":" << (worker.realtime() ? "true" : "false") << "}\n";
        if (config.runner.live && !worker.realtime())
            throw std::runtime_error("live inference real-time setup failed");
        const auto start_control = [&] {
            pin_thread(layout.control);
            name_thread("fh-control");
            report_runner_cpus(layout.control);
            if (!realtime(config) && config.runner.live)
                throw std::runtime_error("live real-time setup failed");
            report_schedule("control", pthread_self(), config.priority);
            report_schedule("sensing", worker.thread(), sensing_priority);
            report_schedule("record", trace.thread(), 0);
        };
        if (!config.nic.empty()) {
#ifdef FOOTHOLD_UNITREE
            if (layout.split) pin_thread(layout.io);
            UnitreeRobot robot(config.nic, config.runner.live, config.factory_mode);
            std::optional<ModeWorker> modes;
            if (config.runner.live) modes.emplace(robot);
            start_control();
            return run(config, robot, worker, trace, read_depth, [&](Tick) { return robot.read(); },
                       [&] { return robot.writes(); }, modes ? &*modes : nullptr);
#else
            throw std::invalid_argument("binary was built without the Unitree SDK");
#endif
        }
        start_control();
        DryRobot robot;
        return run(config, robot, worker, trace, read_depth,
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
