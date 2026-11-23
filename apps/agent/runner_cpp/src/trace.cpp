#include "foothold/trace.hpp"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <thread>
#include <unistd.h>

using namespace std::chrono_literals;

namespace foothold {
namespace {
constexpr std::uint64_t file_limit = 50'000'000;
constexpr std::uint64_t total_limit = 2'000'000'000;
constexpr auto active_flag = "/tmp/foothold-start-active";
using Wall = std::chrono::system_clock;
using Ms = std::chrono::duration<double, std::milli>;

const char* phase_name(Phase phase) {
    switch (phase) {
    case Phase::high: return "high";
    case Phase::acquiring: return "acquiring";
    case Phase::folding:
    case Phase::standing: return "standing_up";
    case Phase::policy: return "policy";
    case Phase::sitting: return "sitting";
    case Phase::damping: return "damping";
    case Phase::returning: return "returning";
    case Phase::recovering: return "recovering";
    }
    return "unknown";
}

enum class Kind { event, sample, status };
struct Row {
    Kind kind;
    Tick time;
    Wall::time_point wall;
    Event event;
    EventInfo info;
    LowState state;
    Vec3 grav, goal, command;
    Wanted want;
    Mark shape;
    Joints target;
    Phase phase;
    std::uint64_t commands, writes, n_policy, n_control, late_policy, late_control, resyncs;
    double p99_policy, max_policy, recent_p99, recent_max, p99_control, max_control;
};

template<class Range>
void array(std::ostream& out, const Range& values) {
    out << '[';
    bool first = true;
    for (const auto value : values) {
        if (!first) out << ',';
        first = false;
        if (std::isfinite(value)) out << value;
        else out << "null";
    }
    out << ']';
}

void keys(std::ostream& out, std::uint16_t value) {
    constexpr std::pair<int, const char*> sorted[]{
        {8,"A"}, {9,"B"}, {6,"F1"}, {7,"F2"}, {1,"L1"}, {5,"L2"}, {0,"R1"}, {4,"R2"},
        {10,"X"}, {11,"Y"}, {14,"down"}, {15,"left"}, {13,"right"}, {3,"select"},
        {2,"start"}, {12,"up"},
    };
    out << '[';
    bool first = true;
    for (const auto& [bit, name] : sorted) {
        if ((value & (1u << bit)) == 0) continue;
        if (!first) out << ',';
        first = false;
        out << '"' << name << '"';
    }
    out << ']';
}

std::string line(const Row& row) {
    using Seconds = std::chrono::duration<double>;
    std::ostringstream out;
    out << std::fixed << std::setprecision(4)
        << "{\"t\":" << Seconds(row.time.time_since_epoch()).count()
        << ",\"wall\":" << std::setprecision(3) << Seconds(row.wall.time_since_epoch()).count();
    if (row.kind == Kind::event) {
        out << ",\"event\":\"" << event_name(row.event) << '"';
        if (row.event == Event::damping)
            out << ",\"reason\":\"" << row.info.text << '"';
        if (row.event == Event::policy_start)
            out << ",\"mode\":\"" << row.info.text << '"';
        if (row.event == Event::stand_fold)
            out << ",\"sec\":" << row.info.value;
        if (row.event == Event::stand_refused)
            out << ",\"reason\":\"" << row.info.text << "\",\"tilt_deg\":"
                << std::round(row.info.value * 10) / 10;

        if (row.event == Event::liveness_lost)
            out << ",\"seconds\":" << row.info.value;
        if (row.event == Event::robot_fall)
            out << ",\"grav_z\":" << row.info.value;
        if (row.event == Event::factory_handover)
            out << ",\"gait\":\"" << row.info.text << "\",\"holding\":false";
        out << "}\n";
        return out.str();
    }
    const auto& s = row.state;
    out << std::setprecision(4) << ",\"phase\":\"policy\",\"stick\":";
    array(out, Vec3{s.remote.lx, s.remote.ly, s.remote.rx});
    out << ",\"keys\":";
    keys(out, s.remote.keys);
    out << ",\"want\":";
    array(out, row.want);
    out << ",\"shape\":\"" << mark_name(row.shape) << "\",\"goal\":";
    array(out, row.goal);
    out << ",\"cmd\":";
    array(out, row.command);
    out << ",\"target\":";
    array(out, row.target);
    out << ",\"q\":";
    array(out, to_policy(s.q));
    out << ",\"dq\":";
    array(out, to_policy(s.dq));
    out << ",\"tau\":";
    array(out, to_policy(s.tau));
    out << ",\"temp\":";
    array(out, to_policy(s.temperature));
    out << ",\"foot\":";
    array(out, s.foot);
    out << ",\"gyro\":";
    array(out, s.gyro);
    out << ",\"grav\":";
    array(out, row.grav);
    out << ",\"est_vx\":[null,null]}\n";
    return out.str();
}
}

void PeriodStats::mark(Tick::duration elapsed) {
    const auto bin = std::chrono::duration_cast<std::chrono::microseconds>(elapsed).count() / 100;
    ++histogram_[std::clamp<std::int64_t>(bin, 0, histogram_.size() - 1)];
    recent_[count % recent_.size()] = Ms(elapsed).count();
    ++count;
    if (elapsed > 30ms) ++over_30_ms;
    max_ = std::max(max_, elapsed);
}

double PeriodStats::p99_ms() const {
    if (count == 0) return 0;
    const auto rank = count - count / 100;
    std::uint64_t seen = 0;
    for (std::size_t i = 0; i < histogram_.size(); ++i) {
        seen += histogram_[i];
        if (seen >= rank)
            return i == histogram_.size() - 1 ? max_ms() : std::min(max_ms(), (i + 1) / 10.);
    }
    return max_ms();
}
double PeriodStats::max_ms() const { return Ms(max_).count(); }

std::pair<double, double> PeriodStats::recent_ms() const {
    const auto size = std::min<std::uint64_t>(count, recent_.size());
    if (!size) return {0, 0};
    auto recent = recent_;
    const auto end = recent.begin() + size;
    const auto p99 = recent.begin() + std::min(size - 1, size * 99 / 100);
    const auto max = *std::max_element(recent.begin(), end);
    std::nth_element(recent.begin(), p99, end);
    return {std::round(*p99 * 10) / 10, std::round(max * 10) / 10};
}

struct Trace::Impl {
    static constexpr std::size_t capacity = 1024;
    std::array<Row, capacity> ring{};
    std::atomic<std::size_t> head{0}, tail{0};
    std::atomic<unsigned int> marker{0};
    std::atomic<std::uint64_t> drops{0};
    std::atomic<bool> done{false}, error{false};
    const std::filesystem::path folder;
    const bool live;
    std::filesystem::path stem;
    std::uint64_t total = 0, size = 0, index = 0, rows = 0;
    bool full = false;
    std::ofstream file;
    std::thread writer;

    Impl(std::filesystem::path path, bool live) : folder(std::move(path)), live(live) {
        if (!folder.empty()) {
            std::filesystem::create_directories(folder);
            for (const auto& entry : std::filesystem::directory_iterator(folder))
                if (entry.is_regular_file() && entry.path().extension() == ".jsonl") total += entry.file_size();
            const auto ns = Wall::now().time_since_epoch().count();
            stem = folder / ("start-" + std::to_string(ns) + "-" + std::to_string(getpid()));
        }
        writer = std::thread([this] { drain(); });
    }

    void push(const Row& row) {
        const auto current = head.load(std::memory_order_relaxed);
        const auto next = (current + 1) % capacity;
        if (next == tail.load(std::memory_order_acquire)) {
            drops.fetch_add(1, std::memory_order_relaxed);
            return;
        }
        ring[current] = row;
        head.store(next, std::memory_order_release);
    }

    void output(const Row& row) {
        if (row.kind == Kind::status) {
            std::cout << "{\"status\":\"" << phase_name(row.phase) << "\",\"commands\":" << row.commands
                      << ",\"lowcmd_writes\":" << row.writes << ",\"policy_period_count\":" << row.n_policy
                      << ",\"policy_period_p99_ms\":" << row.p99_policy
                      << ",\"policy_period_max_ms\":" << row.max_policy
                      << ",\"policy_period_over_30_ms\":" << row.late_policy
                      << ",\"control_period_count\":" << row.n_control
                      << ",\"control_period_p99_ms\":" << row.p99_control
                      << ",\"control_period_max_ms\":" << row.max_control
                      << ",\"control_period_over_30_ms\":" << row.late_control
                      << ",\"dt_p99\":" << row.recent_p99 << ",\"dt_max\":" << row.recent_max
                      << ",\"dt_over30\":" << row.late_policy << ",\"dt_n\":" << row.n_policy
                      << ",\"resync\":" << row.resyncs << ",\"trace_drops\":" << drops.load()
                      << ",\"trace_error\":" << (error.load() ? "true" : "false") << "}\n" << std::flush;
            return;
        }
        if (row.kind == Kind::event)
            std::cout << "{\"code\":\"" << event_name(row.event) << "\"}\n" << std::flush;
        if (folder.empty() || full || error.load()) return;
        const auto jsonl = line(row);
        if (total + jsonl.size() > total_limit) {
            full = true;
            file.close();
            std::cout << "{\"code\":\"TRACE_FULL\"}\n" << std::flush;
            return;
        }
        if (!file.is_open() || size + jsonl.size() > file_limit) {
            if (file.is_open()) file.close();
            std::ostringstream suffix;
            suffix << '-' << std::setw(3) << std::setfill('0') << index++ << ".jsonl";
            file.open(stem.string() + suffix.str(), std::ios::binary);
            size = 0;
        }
        file << jsonl;
        size += jsonl.size();
        total += jsonl.size();
        if (++rows % 50 == 0) file.flush();
        if (!file) log_failure("trace write failed");
    }

    void log_failure(const char* what) {
        if (!error.exchange(true)) std::cerr << what << '\n';
    }

    void drain() {
        unsigned int seen_marker = 0;
        while (true) {
            const auto want_marker = marker.load(std::memory_order_acquire);
            if (live && want_marker != seen_marker) {
                seen_marker = want_marker;
                try {
                    if (want_marker & 1) {
                        std::ofstream flag(active_flag);
                        if (!flag) throw std::runtime_error("cannot create START active flag");
                    } else {
                        std::filesystem::remove(active_flag);
                    }
                } catch (const std::exception& err) {
                    log_failure(err.what());
                }
            }
            const auto current = tail.load(std::memory_order_relaxed);
            if (current != head.load(std::memory_order_acquire)) {
                try {
                    output(ring[current]);
                } catch (const std::exception& err) {
                    log_failure(err.what());
                }
                tail.store((current + 1) % capacity, std::memory_order_release);
            } else if (done.load(std::memory_order_acquire)) {
                if (marker.load(std::memory_order_acquire) == seen_marker) break;
            } else {
                std::this_thread::sleep_for(5ms);
            }
        }
        if (file.is_open()) {
            file.close();
            if (!file) log_failure("trace close failed");
        }
    }
};

Trace::Trace(std::filesystem::path directory, bool live)
    : impl_(std::make_unique<Impl>(std::move(directory), live)) {}
Trace::~Trace() { close(); }
void Trace::event(Tick now, Event event, EventInfo info) {
    if (impl_->live) {
        if (event == Event::mode_low) impl_->marker.store(1, std::memory_order_release);
        if (event == Event::mode_high) impl_->marker.store(2, std::memory_order_release);
    }
    Row row{};
    row.kind = Kind::event;
    row.time = now;
    row.wall = Wall::now();
    row.event = event;
    row.info = info;
    impl_->push(row);
}

void Trace::sample(const Sample& sample) {
    if (impl_->folder.empty()) return;
    Row row{};
    row.kind = Kind::sample;
    row.time = sample.time;
    row.wall = Wall::now();
    row.state = sample.state;
    row.grav = sample.gravity;
    row.want = sample.want;
    row.goal = sample.goal;
    row.command = sample.command;
    row.shape = sample.shape;
    row.target = sample.target;
    impl_->push(row);
}

void Trace::status(Tick now, Phase phase, std::uint64_t commands, std::uint64_t writes,
                   const PeriodStats& policy, const PeriodStats& control, std::uint64_t resyncs) {
    Row row{};
    row.kind = Kind::status;
    row.time = now;
    row.phase = phase;
    row.commands = commands;
    row.writes = writes;
    row.n_policy = policy.count;
    row.p99_policy = policy.p99_ms();
    row.max_policy = policy.max_ms();
    const auto [recent_p99, recent_max] = policy.recent_ms();
    row.recent_p99 = recent_p99;
    row.recent_max = recent_max;
    row.late_policy = policy.over_30_ms;
    row.n_control = control.count;
    row.p99_control = control.p99_ms();
    row.max_control = control.max_ms();
    row.late_control = control.over_30_ms;
    row.resyncs = resyncs;
    impl_->push(row);
}

void Trace::close() {
    impl_->done.store(true, std::memory_order_release);
    if (impl_->writer.joinable()) impl_->writer.join();
}
bool Trace::failed() const { return impl_->error.load(); }
std::uint64_t Trace::dropped() const { return impl_->drops.load(); }

}
